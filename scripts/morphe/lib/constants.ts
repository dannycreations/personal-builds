export const VERSION_PATTERN = /(\d+(?:\.\d+)*(?:[-.][a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*)?)/;

export const SUPPORTED_VERSION_LINE_PATTERN = new RegExp(`^${VERSION_PATTERN.source}(?:\\s*\\[[^\\]]*\\])?\\s+\\(\\d+\\s+patches\\)$`);
