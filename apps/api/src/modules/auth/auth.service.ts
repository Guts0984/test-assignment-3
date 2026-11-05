import {
  ErrorCode,
  publicUserSchema,
  type LoginBody,
  type PublicUser,
  type RegisterBody,
} from "@app/shared";
import { createAppError } from "../../lib/app-error";
import type { PasswordHasher } from "./password-hasher";
import type { SessionStore } from "./session-store";
import type { UsersRepository } from "./users.repository";

export interface AuthResult {
  user: PublicUser;
  sessionId: string;
  ttlSeconds: number;
}

export interface AuthService {
  register: (input: RegisterBody) => Promise<AuthResult>;
  login: (input: LoginBody) => Promise<AuthResult>;
  logout: (sessionId: string) => Promise<void>;
  /** The logged-in user behind a session id, or undefined (no session, expired, user gone). */
  userForSession: (sessionId: string) => Promise<PublicUser | undefined>;
}

export interface AuthServiceDeps {
  users: UsersRepository;
  hasher: PasswordHasher;
  sessions: SessionStore;
}

const emailTaken = () =>
  createAppError(409, ErrorCode.EMAIL_TAKEN, "This email is already registered. Try logging in.");

// One message for "no such email" and "wrong password", so it does not reveal who is registered.
const invalidCredentials = () =>
  createAppError(401, ErrorCode.INVALID_CREDENTIALS, "The email or password is not correct.");

export function createAuthService({ users, hasher, sessions }: AuthServiceDeps): AuthService {
  async function startSession(row: Parameters<typeof publicUserSchema.parse>[0]): Promise<AuthResult> {
    // Parsing with the public schema drops the password hash.
    const user = publicUserSchema.parse(row);
    const { sessionId, ttlSeconds } = await sessions.create(user.id);
    return { user, sessionId, ttlSeconds };
  }

  return {
    async register({ email, password }) {
      const passwordHash = await hasher.hash(password);
      const created = await users.create({ email, passwordHash });
      if (created === "email_taken") throw emailTaken();
      return startSession(created);
    },

    async login({ email, password }) {
      const user = await users.findByEmail(email);
      if (!user) {
        await hasher.verifyNothing(password); // take as long as a real check
        throw invalidCredentials();
      }
      if (!(await hasher.verify(user.passwordHash, password))) throw invalidCredentials();
      return startSession(user);
    },

    logout: (sessionId) => sessions.destroy(sessionId),

    async userForSession(sessionId) {
      const session = await sessions.find(sessionId);
      if (!session) return undefined;
      const user = await users.findById(session.userId);
      return user ? publicUserSchema.parse(user) : undefined;
    },
  };
}
