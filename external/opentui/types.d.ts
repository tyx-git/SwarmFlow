declare global {
  const Bun: {
    stringWidth(text: string): number;
  };
}

export {};
