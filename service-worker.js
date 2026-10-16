const TAG = "[AI-Fill]";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Text-only questions -> Cerebras (fast)
const TEXT_API = {
    url: "https://api.cerebras.ai/v1/chat/completions",
    key: "csk-9ntynen6djwc8w5h49dxtmdn4nejk58vndhynkhfjffpwtwp",          // حط الـ key ديال Cerebras هنا
    model: "gpt-oss-120b",
    extra: { reasoning_effort: "low" }
};

// Questions with images -> any vision model exposed through an OpenAI-compatible endpoint
// Example (Gemini):  url = https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
// Example (OpenAI):  url = https://api.openai.com/v1/chat/completions
const VISION_API = {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    key: "PUT_VISION_KEY_HERE",        // حط الـ key ديال الموديل اللي كيشوف الصور
    model: "gemini-2.5-flash",         // بدّلو بأي موديل كيدعم الصور
    extra: {}
};

function buildSystemPrompt(multiple, hasImages) {
    const base = multiple
        ? "You are a quiz solver. The question may have MORE THAN ONE correct choice. " +
          "Output ONLY a valid JSON object like {\"choiceIndexes\": [0, 2]} " +
          "containing the 0-based indexes of ALL correct choices."
        : "You are a quiz solver. Output ONLY a valid JSON object like {\"choiceIndexes\": [0]} " +
          "containing the 0-based index of the single correct choice.";
    return hasImages
        ? base + " Some images are attached; the question or the choices may depend on them, so read them carefully."
        : base;
}

function buildUserContent(question) {
    const payload = JSON.stringify({ question: question.question, choices: question.choices });
    if (!question.images || !question.images.length) return payload;

    const parts = [{ type: "text", text: payload }];
    for (const img of question.images) {
        parts.push({ type: "text", text: img.label + ":" });
        parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
    }
    return parts;
}

async function callModel(question, maxRetries = 3) {
    const hasImages = !!(question.images && question.images.length);
    const cfg = hasImages ? VISION_API : TEXT_API;

    if (!cfg.key || cfg.key.startsWith("PUT_")) {
        throw new Error(`API key not set for ${hasImages ? "VISION_API" : "TEXT_API"} in service-worker.js`);
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await fetch(cfg.url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${cfg.key}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: cfg.model,
                messages: [
                    { role: "system", content: buildSystemPrompt(!!question.multiple, hasImages) },
                    { role: "user", content: buildUserContent(question) }
                ],
                temperature: 0.0,
                max_tokens: 4096,
                ...cfg.extra
            })
        });

        if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
            const retryAfter = Number(response.headers.get("retry-after"));
            const wait = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
            console.warn(TAG, `HTTP ${response.status}, retrying in ${wait}ms (attempt ${attempt + 1}/${maxRetries})`);
            await sleep(wait);
            continue;
        }

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            const msg = Array.isArray(data) ? data[0]?.error?.message : data.error?.message;
            throw new Error(msg || `HTTP ${response.status} from ${cfg.url}`);
        }

        const answer = data.choices?.[0]?.message?.content;
        if (!answer) {
            const fr = data.choices?.[0]?.finish_reason;
            throw new Error(
                `Empty answer from model (finish_reason: ${fr ?? "unknown"}, ` +
                `completion_tokens: ${data.usage?.completion_tokens ?? "?"})`
            );
        }

        const jsonMatch = answer.match(/\{[\s\S]*?\}/);
        return jsonMatch ? jsonMatch[0] : answer;
    }
    throw new Error("Max retries reached");
}

async function fetchImageAsDataURL(url) {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(`Image HTTP ${r.status}`);
    const blob = await r.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return `data:${blob.type || "image/png"};base64,${btoa(bin)}`;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return;

    if (message.type === "ASK_CEREBRAS") {
        callModel(message.question)
            .then((answer) => sendResponse({ success: true, answer }))
            .catch((err) => {
                console.error(TAG, "Model error:", err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    if (message.type === "FETCH_IMAGE") {
        fetchImageAsDataURL(message.url)
            .then((dataUrl) => sendResponse({ success: true, dataUrl }))
            .catch((err) => {
                console.error(TAG, "Image fetch error:", err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }
});

chrome.action.onClicked.addListener(async (tab) => {
    if (!tab || tab.id == null) return;

    try {
        await chrome.tabs.sendMessage(tab.id, { type: "START_FILL" });
    } catch (e) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["content.js"]
            });
            await chrome.tabs.sendMessage(tab.id, { type: "START_FILL" });
        } catch (e2) {
            console.error(TAG, "Could not inject content script:", e2);
        }
    }
});