/** A job that cannot finish, with the reason its caller sees. */
export class JobFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobFailureError";
  }
}
