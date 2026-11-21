export interface RunArtifact { id: string; display_name: string; mime_type: string; size_bytes: number; state: string; created_at: string }
export interface RewindFile { path: string; operationCount: number; reason?: string }
export interface FileRewindPreview {
  canApply: boolean; previewToken: string; reverted: boolean;
  safeFiles: RewindFile[]; unsafeFiles: RewindFile[]; ignoredFiles: RewindFile[];
}
