// Keep one dropped image until the lazy search panel has mounted.
let pendingImage: string | undefined
let receiver: ((imagePath: string) => void) | undefined

export function requestWorkspaceImageSearch(imagePath: string): void {
  if (receiver) receiver(imagePath)
  else pendingImage = imagePath
}

export function subscribeWorkspaceImageSearch(handler: (imagePath: string) => void): () => void {
  receiver = handler
  if (pendingImage !== undefined) {
    const imagePath = pendingImage
    pendingImage = undefined
    handler(imagePath)
  }
  return () => {
    if (receiver === handler) receiver = undefined
  }
}
