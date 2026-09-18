declare module "mammoth" {
  interface MammothMessage {
    type: string;
    message: string;
  }

  interface MammothResult {
    value: string;
    messages: MammothMessage[];
  }

  interface MammothImage {
    contentType: string;
    read(encoding?: string): Promise<string | Buffer>;
  }

  interface MammothOptions {
    convertImage?: unknown;
    styleMap?: string | string[];
  }

  const mammoth: {
    convertToHtml(
      input: { path: string } | { buffer: Buffer },
      options?: MammothOptions,
    ): Promise<MammothResult>;
    images: {
      imgElement(
        handler: (image: MammothImage) => Promise<Record<string, string>> | Record<string, string>,
      ): unknown;
    };
  };

  export default mammoth;
}
