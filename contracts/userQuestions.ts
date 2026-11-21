/** AskUserQuestion interaction, adapted from ZCode; answers are supplied only by the user interface. */
export const ASK_USER_QUESTION = 'AskUserQuestion';
export interface UserQuestionOption { label: string; description: string; preview?: string }
export interface UserQuestion { header: string; question: string; options: UserQuestionOption[]; multiSelect: boolean }
export interface UserQuestionRequest {
    id: string; runId: string; invocationId: string; questions: UserQuestion[];
    state: 'pending' | 'answered' | 'skipped' | 'auto_continued' | 'cancelled';
    answers: Record<string, string[]>; createdAt: string; resolvedAt: string | null;
    deadlineAt: string | null; snoozedAt: string | null;
}
export interface UserQuestionResponse { action: 'answer' | 'skip'; answers?: Record<string, string[]> }
