export interface MemoryFileView { filename: string; description?: string; type?: string; mtimeMs: number; sizeBytes: number }
export interface MemoryProjectView { id: string; name: string; files: MemoryFileView[] }
export interface HandoffSaveInput { source_path?: string; source_hash: string; summary: string; verified: string[]; unverified: string[]; next_steps: string[] }
export interface MemoryExtractionContext { operationId?: string; skipped?: string; messages?: Array<{ role: string; text: string }>; files?: MemoryFileView[] }
