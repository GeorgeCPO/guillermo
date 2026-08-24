export class HttpError extends Error {
  public constructor(public readonly status: number, public readonly reason: string) {
    super(reason);
  }
}
