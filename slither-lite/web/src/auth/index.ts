import type { AuthService } from "./service";
import { UnavailableAuthService } from "./service";

/** The single auth instance used by the site. Replace with a real implementation when accounts ship. */
export const auth: AuthService = new UnavailableAuthService();
