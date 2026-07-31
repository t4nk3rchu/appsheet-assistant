export interface CompletionRequest {
  system: string; prompt: string; apiKey: string; model?: string; baseUrl?: string;
}
export interface AiProvider {
  id: string; label: string;
  complete(req: CompletionRequest): Promise<string>;
}
