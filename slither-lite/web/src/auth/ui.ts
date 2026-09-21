import { escapeHtml } from "../util/html";
import { AuthError, type AuthService } from "./service";

type Mode = "signIn" | "signUp";

export interface AuthUi {
  open(mode?: Mode): void;
}

/** Renders the header account widget and the sign-in dialog. All account behaviour goes through `auth`. */
export function mountAuth(auth: AuthService, slot: HTMLElement, dialog: HTMLDialogElement): AuthUi {
  let mode: Mode = "signIn";
  let pending = false;
  let error = "";

  const renderSlot = (): void => {
    const user = auth.user;
    if (!user) {
      slot.innerHTML = `<button type="button" class="btn btn-ghost" id="open-sign-in">Sign in</button>`;
      slot.querySelector("#open-sign-in")?.addEventListener("click", () => open("signIn"));
      return;
    }
    slot.innerHTML = `
      <span class="avatar" aria-hidden="true">${escapeHtml(user.displayName.slice(0, 1).toUpperCase())}</span>
      <span class="account-name">${escapeHtml(user.displayName)}</span>
      <button type="button" class="btn btn-ghost" id="sign-out">Sign out</button>`;
    slot.querySelector("#sign-out")?.addEventListener("click", () => void auth.signOut());
  };

  const renderDialog = (): void => {
    const signUp = mode === "signUp";
    dialog.innerHTML = `
      <form method="dialog" class="auth-form" id="auth-form" novalidate>
        <div class="auth-head">
          <h2 id="auth-title">${signUp ? "Create your account" : "Welcome back"}</h2>
          <button type="button" class="icon-button" id="auth-close" aria-label="Close">×</button>
        </div>
        <div class="tabs" role="tablist" aria-label="Account">
          <button type="button" role="tab" aria-selected="${!signUp}" data-mode="signIn">Sign in</button>
          <button type="button" role="tab" aria-selected="${signUp}" data-mode="signUp">Create account</button>
        </div>
        <p class="notice">Preview: accounts aren't live yet. PaperArena is open to guests, so you can play without signing in.</p>
        ${signUp ? `<label>Display name<input name="displayName" maxlength="20" autocomplete="nickname" required /></label>` : ""}
        <label>Email<input name="email" type="email" autocomplete="email" required /></label>
        <label>Password<input name="password" type="password" minlength="${signUp ? 8 : 1}" autocomplete="${signUp ? "new-password" : "current-password"}" required /></label>
        <div class="form-error" role="alert" id="auth-error">${escapeHtml(error)}</div>
        <button type="submit" class="btn btn-primary btn-block" ${pending ? "disabled" : ""}>${pending ? "Please wait…" : signUp ? "Create account" : "Sign in"}</button>
        <button type="button" class="link-button" id="auth-guest">Continue as guest</button>
      </form>`;
    dialog.setAttribute("aria-labelledby", "auth-title");
    dialog.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((tab) =>
      tab.addEventListener("click", () => {
        mode = tab.dataset.mode as Mode;
        error = "";
        renderDialog();
        dialog.querySelector<HTMLInputElement>("input")?.focus();
      }),
    );
    dialog.querySelector("#auth-close")?.addEventListener("click", () => dialog.close());
    dialog.querySelector("#auth-guest")?.addEventListener("click", () => dialog.close());
    dialog.querySelector<HTMLFormElement>("#auth-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void submit(event.currentTarget as HTMLFormElement);
    });
  };

  const submit = async (form: HTMLFormElement): Promise<void> => {
    if (!form.reportValidity() || pending) return;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    pending = true;
    error = "";
    renderDialog();
    try {
      if (mode === "signUp") await auth.signUp({ email, password, displayName: String(data.get("displayName") ?? "").trim() });
      else await auth.signIn({ email, password });
      pending = false;
      dialog.close();
    } catch (failure) {
      pending = false;
      error = failure instanceof AuthError ? failure.message : "Something went wrong. Please try again.";
      renderDialog();
    }
  };

  function open(next: Mode = "signIn"): void {
    mode = next;
    error = "";
    pending = false;
    renderDialog();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLInputElement>("input")?.focus();
  }

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  auth.subscribe(renderSlot);
  renderSlot();
  return { open };
}
