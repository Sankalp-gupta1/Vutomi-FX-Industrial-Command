export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assertFound<T>(row: T | null | undefined, message: string): T {
  if (!row) throw new AppError(404, message);
  return row;
}
