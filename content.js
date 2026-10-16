const TAG = "[AI-Fill]";
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const error = (...a) => console.error(TAG, ...a);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- AI request ---------------- */

function sendToWorker(payload) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: "ASK_CEREBRAS", question: payload }, (response) => {
                if (chrome.runtime.lastError) {
                    warn("Runtime error:", chrome.runtime.lastError.message);
                    resolve(null);
                    return;
                }
                if (!response || !response.success) {
                    warn("AI request failed:", response && response.error);
                    resolve(null);
                    return;
                }
                try {
                    resolve(JSON.parse(response.answer));
                } catch (e) {
                    warn("Could not parse AI answer:", response.answer);
                    resolve(null);
                }
            });
        } catch (e) {
            error("sendMessage threw:", e);
            resolve(null);
        }
    });
}

// Normalise the AI answer to a clean array of valid indexes
function extractIndexes(result, max, multiple) {
    if (!result) return [];
    let raw = result.choiceIndexes ?? result.choiceIndex;
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) raw = [raw];
    let idx = raw
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0 && n < max);
    idx = [...new Set(idx)];
    if (!multiple) idx = idx.slice(0, 1);
    return idx;
}

async function askAIForAnswer(questionData, attempts = 2) {
    for (let i = 0; i < attempts; i++) {
        const result = await sendToWorker(questionData);
        const idx = extractIndexes(result, questionData.choices.length, questionData.multiple);
        if (idx.length) return idx;
        if (i < attempts - 1) await delay(1500);
    }
    return [];
}

/* ---------------- Scroll guard ---------------- */

let lastUserScrollIntent = 0;
["wheel", "touchmove", "keydown"].forEach((ev) =>
    window.addEventListener(ev, () => { lastUserScrollIntent = Date.now(); }, { passive: true })
);

function captureScrollState() {
    const state = { winX: window.scrollX, winY: window.scrollY, containers: [] };
    document.querySelectorAll("*").forEach((el) => {
        const canScrollY = /(auto|scroll)/.test(getComputedStyle(el).overflowY)
            && el.scrollHeight > el.clientHeight + 2;
        if (canScrollY) state.containers.push({ el, top: el.scrollTop });
    });
    return state;
}

function restoreScrollState(state) {
    window.scrollTo({ left: state.winX, top: state.winY, behavior: "instant" });
    state.containers.forEach((c) => {
        const prev = c.el.style.scrollBehavior;
        c.el.style.scrollBehavior = "auto";
        c.el.scrollTop = c.top;
        c.el.style.scrollBehavior = prev;
    });
}

function clickWithScrollGuard(element, afterClick) {
    const snapshot = captureScrollState();
    const clickedAt = Date.now();

    if (element) element.click();
    if (afterClick) afterClick();

    const restore = () => {
        if (lastUserScrollIntent >= clickedAt) return;
        restoreScrollState(snapshot);
    };
    restore();
    requestAnimationFrame(restore);
    setTimeout(restore, 350);
}

/* ---------------- Images ---------------- */

const MAX_IMG_SIDE = 1568;

async function blobToDataURL(blob) {
    try {
        const bmp = await createImageBitmap(blob);
        const scale = Math.min(1, MAX_IMG_SIDE / Math.max(bmp.width, bmp.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(bmp.width * scale));
        c.height = Math.max(1, Math.round(bmp.height * scale));
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(bmp, 0, 0, c.width, c.height);
        return c.toDataURL("image/jpeg", 0.9);
    } catch (e) {
        return await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.onerror = rej;
            fr.readAsDataURL(blob);
        });
    }
}

function fetchImageViaWorker(url) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: "FETCH_IMAGE", url }, (resp) => {
                if (chrome.runtime.lastError || !resp || !resp.success) {
                    warn("Worker could not fetch image:", (resp && resp.error) || chrome.runtime.lastError?.message);
                    resolve(null);
                    return;
                }
                resolve(resp.dataUrl);
            });
        } catch (e) {
            resolve(null);
        }
    });
}

// Returns a data URL (jpeg/png) for an <img>, or null
async function imageToDataURL(img) {
    const src = img.currentSrc || img.src;
    if (!src) return null;
    try {
        const r = await fetch(src, { credentials: "include" }); // works for data:, blob: and same-origin/CORS urls
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await blobToDataURL(await r.blob());
    } catch (e) {
        warn("Direct image fetch failed, trying via service worker:", e.message);
        const viaWorker = await fetchImageViaWorker(src);
        if (viaWorker) return viaWorker;

        // last resort: draw the already-loaded <img> on a canvas
        try {
            const c = document.createElement("canvas");
            c.width = img.naturalWidth || img.width;
            c.height = img.naturalHeight || img.height;
            c.getContext("2d").drawImage(img, 0, 0);
            return c.toDataURL("image/jpeg", 0.9); // throws if the canvas is tainted (CORS)
        } catch (_) {
            return null;
        }
    }
}

const isRealImage = (n) => (n.naturalWidth || n.width || 0) > 30 && (n.naturalHeight || n.height || 0) > 30;

/* ---------------- Question discovery ---------------- */

const INPUT_SEL = 'input[type="radio"], input[type="checkbox"]';
const CONTAINER_SEL = [
    'div[data-automation-id="questionItem"]',
    'div[data-automation-id*="question"]',
    'div[role="listitem"]',
    'div[role="group"]',
    'div[role="radiogroup"]',
    'fieldset',
    'div.question-item'
].join(",");

const POINTS_RE = /\(\s*\d+(?:[.,]\d+)?\s*points?\s*\)/gi;
const cleanText = (t) => (t || "").replace(POINTS_RE, "").replace(/\s+/g, " ").trim();

// true if the node contains text other than the answer labels (i.e. the question itself)
function hasTextBeyondChoices(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll("label, input, script, style").forEach((n) => n.remove());
    return cleanText(clone.textContent).length > 3;
}

function findQuestionContainers() {
    // 0) QSM (Quiz and Survey Master): each question lives in its own wrapper
    const qsm = [...document.querySelectorAll(
        '.quiz_section, .qsm-question-wrapper, .mlw_qmn_question_wrapper'
    )].filter((el) => el.querySelectorAll(INPUT_SEL).length >= 2);
    if (qsm.length) {
        return qsm.filter((el) => !qsm.some((o) => o !== el && el.contains(o)));
    }

    // 1) candidates that contain at least 2 inputs (a real question has several choices)
    let candidates = [...document.querySelectorAll(CONTAINER_SEL)]
        .filter((el) => el.querySelectorAll(INPUT_SEL).length >= 2);

    // 2) keep only the innermost ones (drop wrappers that contain another candidate)
    candidates = candidates.filter(
        (el) => !candidates.some((other) => other !== el && el.contains(other))
    );

    // 3) fallback: group inputs by name if nothing matched
    if (candidates.length === 0) {
        const groups = new Map();
        document.querySelectorAll(INPUT_SEL).forEach((inp) => {
            const key = inp.name || inp.closest("fieldset, [role]")?.id || "";
            if (!key) return;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(inp);
        });
        groups.forEach((inputs) => {
            if (inputs.length < 2) return;
            let node = inputs[0].parentElement;
            while (node && !inputs.every((i) => node.contains(i))) node = node.parentElement;
            // Climb while the container only holds the answers (no question text yet),
            // but never into a parent that contains other questions' inputs.
            let climbs = 0;
            while (
                node && node.parentElement && climbs < 5 &&
                !hasTextBeyondChoices(node) &&
                node.parentElement.querySelectorAll(INPUT_SEL).length === inputs.length
            ) {
                node = node.parentElement;
                climbs++;
            }
            if (node) candidates.push(node);
        });
    }

    return candidates;
}

function extractQuestionText(el, choices) {
    const choiceSet = new Set(choices);
    const inputCount = el.querySelectorAll(INPUT_SEL).length;
    const SPECIFIC_SEL =
        '.mlw_qmn_question, .qsm-question-title, [data-automation-id="QuestionTextContainer"], ' +
        '[data-automation-id="questionTitle"], [data-automation-id*="question-title"], legend';

    // Text of a node, ignoring labels/inputs and any element whose text equals an answer
    const textWithoutChoices = (node) => {
        const clone = node.cloneNode(true);
        clone.querySelectorAll("label, input, script, style, noscript").forEach((n) => n.remove());
        // Microsoft Forms: ordinal number, required star and hidden helper text
        clone.querySelectorAll(
            '[data-automation-id="questionOrdinal"], [data-automation-id="requiredStar"], [id^="QuestionInfo_"]'
        ).forEach((n) => n.remove());
        clone.querySelectorAll("*").forEach((n) => {
            if (choiceSet.has(cleanText(n.textContent))) n.remove();
        });
        // drop a leading question number like "12)" or "3."
        return cleanText(clone.textContent).replace(/^\s*\d+\s*[).:\-]\s*/, "").trim();
    };

    let node = el;
    for (let level = 0; node && level < 6; level++) {
        const specific = node.querySelector(SPECIFIC_SEL);
        if (specific) {
            const t = textWithoutChoices(specific);
            if (t.length > 2) return { text: t, root: node };
        }

        const t = textWithoutChoices(node);
        if (t.length > 2) return { text: t, root: node };

        // climb, but never into a parent that holds other questions' inputs
        const parent = node.parentElement;
        if (!parent || parent.querySelectorAll(INPUT_SEL).length !== inputCount) break;
        node = parent;
    }
    return { text: "", root: el };
}

function extractChoices(el) {
    const choices = [];
    const inputs = [];

    el.querySelectorAll(INPUT_SEL).forEach((input) => {
        const label =
            input.closest("label") ||
            (input.id && el.querySelector(`label[for="${CSS.escape(input.id)}"]`)) ||
            input.parentElement;
        if (!label) return;
        let text = cleanText(label.innerText);
        const imageEl = [...label.querySelectorAll("img")].find(isRealImage) || null;
        if (!text && imageEl) text = `[image option ${choices.length + 1}]`;
        if (text && !choices.includes(text)) {
            choices.push(text);
            inputs.push({ inputElement: input, labelElement: label, imageEl });
        }
    });

    return { choices, inputs };
}

/* ---------------- Main flow ---------------- */

let isBusy = false;
const processed = new WeakSet();

async function processFormsAutomatically() {
    if (isBusy) return;
    isBusy = true;

    try {
        await delay(600);

        const questions = findQuestionContainers();
        log(`Found ${questions.length} question(s).`);

        for (const el of questions) {
            try {
                if (processed.has(el)) continue;

                const { choices, inputs } = extractChoices(el);
                if (choices.length === 0) continue;

                // Skip questions that already have an answer (avoid toggling checkboxes off)
                if (inputs.some((i) => i.inputElement.checked)) {
                    processed.add(el);
                    continue;
                }

                const multiple = inputs.some((i) => i.inputElement.type === "checkbox");
                const { text: questionText, root } = extractQuestionText(el, choices);

                /* ---- Load images (never skip the question if an image fails) ---- */
                const images = [];
                const failedImages = [];

                const qImgs = [...root.querySelectorAll("img")].filter((n) => !n.closest("label") && isRealImage(n));
                for (let k = 0; k < qImgs.length; k++) {
                    const dataUrl = await imageToDataURL(qImgs[k]);
                    if (dataUrl) {
                        images.push({ label: `Image attached to the question (${k + 1})`, dataUrl });
                    } else {
                        warn("Could not read a question image:", qImgs[k]);
                        failedImages.push(`the image attached to the question (${k + 1})`);
                    }
                }
                for (let k = 0; k < inputs.length; k++) {
                    if (!inputs[k].imageEl) continue;
                    const dataUrl = await imageToDataURL(inputs[k].imageEl);
                    if (dataUrl) {
                        images.push({ label: `Image of choice with index ${k}`, dataUrl });
                    } else {
                        warn("Could not read a choice image:", inputs[k].imageEl);
                        failedImages.push(`the image of choice index ${k}`);
                    }
                }
                if (root.querySelector("canvas")) {
                    warn("Question contains a <canvas> that cannot be captured:", root);
                }

                // Build the final question text
                let finalQuestion = questionText;
                if (!finalQuestion) {
                    finalQuestion = images.length
                        ? "(see the attached image)"
                        : "(the question text is missing or is an image that could not be loaded)";
                }
                if (failedImages.length) {
                    finalQuestion += `\n\nNOTE: ${failedImages.join(", ")} could not be loaded. ` +
                        `Do not refuse. Use the text and the choices to give your best possible answer, even if you must guess.`;
                }

                log("Question:", finalQuestion, "| Choices:", choices, "| Multiple:", multiple, "| Images:", images.length);

                let indexes = await askAIForAnswer({
                    question: finalQuestion,
                    choices,
                    multiple,
                    images
                });

                // If the AI gave nothing valid, never leave it empty: pick a guess
                if (!indexes.length) {
                    const guess = Math.floor(Math.random() * choices.length); // use [0] if you prefer always the first choice
                    warn("AI gave no valid answer, falling back to a guess:", guess, "->", choices[guess]);
                    indexes = [guess];
                }
                log("Answer:", indexes.map((i) => `${i} -> ${choices[i]}`));

                for (const idx of indexes) {
                    const target = inputs[idx];
                    if (target.inputElement.checked) continue;

                    const clickEl = target.labelElement || target.inputElement;
                    clickWithScrollGuard(clickEl, () => {
                        if (!target.labelElement && target.inputElement) {
                            target.inputElement.dispatchEvent(new Event("change", { bubbles: true }));
                        }
                    });
                    await delay(250);
                }

                processed.add(el);
                await delay(1200);
            } catch (e) {
                error("Failed on one question, continuing:", e);
            }
        }

        log("Done.");
    } catch (e) {
        error("Fatal error:", e);
    } finally {
        isBusy = false;
    }
}

if (!window.__aiFillReady) {
    window.__aiFillReady = true;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message && message.type === "START_FILL") {
            if (isBusy) {
                sendResponse({ ok: true, busy: true });
                return false;
            }
            processFormsAutomatically();
            sendResponse({ ok: true });
        }
        return false;
    });
}
