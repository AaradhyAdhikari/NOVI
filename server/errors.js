// An error whose message is safe and useful to say to the user out loud.
export class UserFacingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserFacingError';
  }
}
