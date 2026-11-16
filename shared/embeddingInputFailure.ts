/** The marker is attached only around image decoding, never model inference. */
export class EmbeddingInputDecodeError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = 'EmbeddingInputDecodeError'
  }
}

export async function decodeEmbeddingInput<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw new EmbeddingInputDecodeError(error)
  }
}

export function embeddingWorkerFailure(error: unknown): { error: string; inputFailure?: true } {
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof EmbeddingInputDecodeError ? { inputFailure: true as const } : {}),
  }
}
