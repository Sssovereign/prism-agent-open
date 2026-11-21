/** 阶段④执行交接：最终消息中的【助手回报】逐项验收清单解析（已通过/未通过/待人工确认）。 */
export interface ReceiptItem { item: string; status: '已通过' | '未通过' | '待人工确认'; detail: string }
export interface AssistantReceipts { body: string; items: ReceiptItem[] }
const RECEIPT_RE = /^\d+[.、]\s*(.+?)\s*—\s*(已通过|未通过|待人工确认)\s*[:：]\s*(.*)$/;
const MARKER = '【助手回报】';
export function parseAssistantReceipts(text: string): AssistantReceipts | null {
	const marker = text.indexOf(MARKER);
	if (marker < 0) return null;
	const body = text.slice(0, marker).trimEnd();
	const items: ReceiptItem[] = [];
	for (const line of text.slice(marker + MARKER.length).split('\n')) {
		const match = line.trim().match(RECEIPT_RE);
		if (match) items.push({ item: match[1]!, status: match[2] as ReceiptItem['status'], detail: match[3] ?? '' });
	}
	return items.length ? { body, items } : null;
}
