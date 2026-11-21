/**
 * Worker侧token估算（模型请求预检用）：文本按字符数/3+64折算；图片块按固定预算计，
 * 不随base64字节数线性膨胀。
 *
 * 背景（2026-11-20生产事故）：门禁曾对整个请求体做字符串/3估算，read_image返回的
 * base64被当文本计——一张1.4MB的1600×900 PNG被估成642k token（上游实测约23.6k），
 * 偏差22.8倍导致假阳性CONTEXT_LIMIT_EXCEEDED。各harness同题做法一致：pi按
 * ESTIMATED_IMAGE_CHARS=4800字符/张（≈1371 token），ZCode以"[Attached …]"占位串计数，
 * DSH剥离data只按引用元数据计价。本仓库文本密度按/3，故取4800/3=1600 token/张。
 */
export function estimateTokensOf(value: unknown): number {
    try {
        const text = JSON.stringify(value) ?? '';
        return Math.ceil(text.length / 3) + 64;
    }
    catch { return 4_096; }
}

/** 图片内容块固定token预算（pi按4800字符/张，本仓库文本密度1/3 → 1600/张）。 */
export const IMAGE_ESTIMATED_TOKENS = 1_600;

/**
 * 估算openai-completions请求体输入token：messages[].content中的image_url/image块
 * 原地剥离base64载荷后按文本估算，另加每张固定预算。
 * `parsed`须为bodyText本次新JSON.parse的产物（可原地修改，不与上游共享）；解析失败
 * 或不含图片时回退estimateTokensOf(bodyText)，纯文本请求估算与既有行为一致。
 */
export function estimateRequestTokens(bodyText: string, parsed: unknown): number {
    const messages = typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { messages?: unknown }).messages)
        ? (parsed as { messages: unknown[] }).messages
        : null;
    if (!messages) return estimateTokensOf(bodyText);
    let imageCount = 0;
    for (const message of messages) {
        const content = (message as { content?: unknown } | null)?.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            const block = part as { type?: string; image_url?: unknown; data?: unknown };
            if (block?.type !== 'image_url' && block?.type !== 'image') continue;
            imageCount += 1;
            if (block.type === 'image' && typeof block.data === 'string') {
                block.data = '';
            }
            else if (block.type === 'image_url' && typeof block.image_url === 'string' && block.image_url.startsWith('data:')) {
                block.image_url = '';
            }
            else if (block.type === 'image_url' && typeof block.image_url === 'object' && block.image_url !== null) {
                const url = (block.image_url as { url?: unknown }).url;
                if (typeof url === 'string' && url.startsWith('data:')) (block.image_url as { url: string }).url = '';
            }
            // 非data:URL（http引用）同样按图片预算计，但URL保留照常文本估算
        }
    }
    if (imageCount === 0) return estimateTokensOf(bodyText);
    let textTokens: number;
    try { textTokens = Math.ceil((JSON.stringify(parsed) ?? '').length / 3) + 64; }
    catch { return estimateTokensOf(bodyText); }
    return textTokens + imageCount * IMAGE_ESTIMATED_TOKENS;
}
