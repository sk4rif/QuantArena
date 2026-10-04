/**
 * Account boundary for the site. The UI only talks to `AuthService`, so real
 * accounts are added by implementing this interface and swapping the instance
 * exported from `./index.ts`; no UI code needs to change.
 */
export interface AuthUser {
  id: string;
  displayName: string;
  email: string;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface SignUpDetails extends Credentials {
  displayName: string;
}

export interface AuthService {
  /** Current signed-in user, or `null` for a guest. */
  readonly user: AuthUser | null;
  /** Calls `listener` whenever `user` changes. Returns an unsubscribe function. */
  subscribe(listener: (user: AuthUser | null) => void): () => void;
  signIn(credentials: Credentials): Promise<AuthUser>;
  signUp(details: SignUpDetails): Promise<AuthUser>;
  signOut(): Promise<void>;
}

/** Thrown by services that cannot complete a request; the message is safe to show to players. */
export class AuthError extends Error {
  constructor(message: string, readonly code: "unavailable" | "invalidCredentials" | "emailTaken" | "network" = "unavailable") {
    super(message);
    this.name = "AuthError";
  }
}

/** Placeholder used until accounts exist: nobody can sign in, everyone plays as a guest. */
export class UnavailableAuthService implements AuthService {
  readonly user = null;

  subscribe(): () => void {
    return () => undefined;
  }

  signIn(): Promise<AuthUser> {
    return Promise.reject(unavailable());
  }

  signUp(): Promise<AuthUser> {
    return Promise.reject(unavailable());
  }

  signOut(): Promise<void> {
    return Promise.resolve();
  }
}

function unavailable(): AuthError {
  return new AuthError("Accounts aren't live yet. PaperArena is open to guests, so you can play with the temporary Player name.");
}
