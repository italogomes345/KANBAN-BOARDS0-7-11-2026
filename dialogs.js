const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function ensureDialogElement() {
  let dialog = document.getElementById("app-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "app-dialog";
    dialog.className = "app-custom-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
  }
  return dialog;
}

function getFocusableElements(dialog) {
  const elements = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => {
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && !element.hasAttribute("disabled");
  });
  return elements;
}

function trapFocus(dialog, event) {
  if (event.key !== "Tab") return;
  const focusable = getFocusableElements(dialog);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function restoreDialogFocus(dialog) {
  const previousFocus = dialog.previousFocusElement;
  dialog.previousFocusElement = null;
  if (previousFocus && previousFocus.isConnected) requestAnimationFrame(() => previousFocus.focus());
}

function registerDialogDismissal(dialog, dismiss) {
  const controller = new AbortController();
  dialog.addEventListener("keydown", (event) => trapFocus(dialog, event), { signal: controller.signal });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  }, { signal: controller.signal });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dismiss();
  }, { signal: controller.signal });
  return () => controller.abort();
}

function buildDialogShell({ title, message, confirmText, cancelText, variant = "prompt", description, danger = false, label = "Valor" }) {
  const dialog = ensureDialogElement();
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.previousFocusElement = previousFocus;
  dialog.classList.remove("danger");
  if (danger) dialog.classList.add("danger");
  dialog.setAttribute("aria-labelledby", "dialog-title");
  dialog.innerHTML = "";

  const form = document.createElement("form");
  form.method = "dialog";
  form.className = "custom-dialog-form";
  form.noValidate = true;

  const header = document.createElement("div");
  header.className = "dialog-header";

  const headingWrap = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = variant === "alert" ? "ATENÇÃO" : variant === "confirm" ? "CONFIRMAÇÃO" : "DETALHES";
  const titleNode = document.createElement("h2");
  titleNode.id = "dialog-title";
  titleNode.textContent = title;
  headingWrap.append(eyebrow, titleNode);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "icon-button dialog-close-button";
  closeButton.setAttribute("aria-label", "Fechar");
  closeButton.textContent = "×";

  header.append(headingWrap, closeButton);
  form.append(header);

  if (message) {
    const messageNode = document.createElement("p");
    messageNode.className = "dialog-message";
    messageNode.textContent = message;
    form.append(messageNode);
  }

  if (description) {
    const descriptionNode = document.createElement("p");
    descriptionNode.className = "dialog-description";
    descriptionNode.textContent = description;
    form.append(descriptionNode);
  }

  if (variant === "prompt") {
    const field = document.createElement("label");
    field.className = "dialog-field";
    const labelNode = document.createElement("span");
    labelNode.textContent = label;
    const input = document.createElement("input");
    input.type = "text";
    input.name = "dialog-input";
    input.autocomplete = "off";
    input.setAttribute("aria-label", label);
    field.append(labelNode, input);
    form.append(field);

    const errorNode = document.createElement("p");
    errorNode.className = "dialog-error";
    errorNode.setAttribute("role", "alert");
    errorNode.setAttribute("aria-live", "polite");
    form.append(errorNode);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "secondary-button";
    cancelButton.textContent = cancelText || "Cancelar";
    const submitButton = document.createElement("button");
    submitButton.type = "submit";
    submitButton.className = "primary-button";
    submitButton.textContent = confirmText || "OK";
    actions.append(cancelButton, submitButton);
    form.append(actions);
    dialog.append(form);

    return { dialog, form, input, errorNode, cancelButton, submitButton };
  }

  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  if (variant === "alert") {
    const submitButton = document.createElement("button");
    submitButton.type = "submit";
    submitButton.className = danger ? "danger-button" : "primary-button";
    submitButton.textContent = confirmText || "OK";
    actions.append(submitButton);
    form.append(actions);
    dialog.append(form);
    return { dialog, form, submitButton };
  }

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "secondary-button";
  cancelButton.textContent = cancelText || "Cancelar";
  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = danger ? "danger-button" : "primary-button";
  submitButton.textContent = confirmText || (variant === "alert" ? "OK" : "Confirmar");
  actions.append(cancelButton, submitButton);
  form.append(actions);
  dialog.append(form);
  return { dialog, form, cancelButton, submitButton };
}

export function promptDialog({ title, message, label, defaultValue = "", placeholder = "", confirmText = "OK", cancelText = "Cancelar", maxLength = 200 } = {}) {
  return new Promise((resolve) => {
    const { dialog, form, input, errorNode, cancelButton, submitButton } = buildDialogShell({
      title,
      message,
      confirmText,
      cancelText,
      variant: "prompt",
      description: "",
      label: label || "Valor"
    });

    input.value = defaultValue;
    input.placeholder = placeholder;
    input.maxLength = maxLength;

    const validateInput = () => {
      const value = input.value.trim();
      if (!value) {
        errorNode.textContent = "Informe um valor antes de continuar.";
        input.focus();
        return false;
      }
      errorNode.textContent = "";
      return true;
    };

    let unregisterDismissal = () => {};
    const closeAndResolve = (value) => {
      unregisterDismissal();
      if (dialog.open) dialog.close();
      resolve(value);
      restoreDialogFocus(dialog);
    };

    unregisterDismissal = registerDialogDismissal(dialog, () => closeAndResolve(null));
    cancelButton.addEventListener("click", () => closeAndResolve(null));
    closeButtonHandler(dialog, () => closeAndResolve(null));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!validateInput()) return;
      closeAndResolve(input.value.trim());
    });
    if (dialog.showModal) dialog.showModal();
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

export function confirmDialog({ title, message, confirmText = "OK", cancelText = "Cancelar", danger = false } = {}) {
  return new Promise((resolve) => {
    const { dialog, form, cancelButton, submitButton } = buildDialogShell({
      title,
      message,
      confirmText,
      cancelText,
      variant: "confirm",
      danger
    });

    let unregisterDismissal = () => {};
    const closeAndResolve = (value) => {
      unregisterDismissal();
      if (dialog.open) dialog.close();
      resolve(value);
      restoreDialogFocus(dialog);
    };

    unregisterDismissal = registerDialogDismissal(dialog, () => closeAndResolve(false));
    cancelButton.addEventListener("click", () => closeAndResolve(false));
    closeButtonHandler(dialog, () => closeAndResolve(false));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      closeAndResolve(true);
    });
    if (dialog.showModal) dialog.showModal();
    requestAnimationFrame(() => {
      submitButton.focus();
    });
  });
}

export function alertDialog({ title, message, okText = "OK" } = {}) {
  return new Promise((resolve) => {
    const { dialog, form, submitButton } = buildDialogShell({
      title,
      message,
      confirmText: okText,
      cancelText: "",
      variant: "alert"
    });

    let unregisterDismissal = () => {};
    const closeAndResolve = () => {
      unregisterDismissal();
      if (dialog.open) dialog.close();
      resolve();
      restoreDialogFocus(dialog);
    };

    unregisterDismissal = registerDialogDismissal(dialog, closeAndResolve);
    closeButtonHandler(dialog, closeAndResolve);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      closeAndResolve();
    });
    if (dialog.showModal) dialog.showModal();
    requestAnimationFrame(() => {
      submitButton.focus();
    });
  });
}

function closeButtonHandler(dialog, closeAction) {
  const closeButton = dialog.querySelector(".dialog-close-button");
  if (closeButton) {
    closeButton.addEventListener("click", closeAction);
  }
}
