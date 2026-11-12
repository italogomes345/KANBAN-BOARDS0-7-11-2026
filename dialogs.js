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

function closeDialog(dialog, resolve, value) {
  if (!dialog) return;
  const previousFocus = dialog.dataset.lastFocus ? document.getElementById(dialog.dataset.lastFocus) : null;
  if (dialog.open) dialog.close();
  dialog.removeAttribute("data-last-focus");
  if (typeof resolve === "function") resolve(value);
  if (previousFocus && typeof previousFocus.focus === "function") {
    requestAnimationFrame(() => previousFocus.focus());
  }
}

function buildDialogShell({ title, message, confirmText, cancelText, variant = "prompt", description, danger = false, label = "Valor" }) {
  const dialog = ensureDialogElement();
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.dataset.lastFocus = previousFocus && previousFocus.id ? previousFocus.id : "";
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

    return { dialog, form, input, errorNode, cancelButton, submitButton };
  }

  const actions = document.createElement("div");
  actions.className = "dialog-actions";
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

    const closeAndResolve = (value) => {
      const previousFocus = dialog.dataset.lastFocus ? document.getElementById(dialog.dataset.lastFocus) : null;
      dialog.close();
      dialog.removeAttribute("data-last-focus");
      resolve(value);
      if (previousFocus && typeof previousFocus.focus === "function") {
        requestAnimationFrame(() => previousFocus.focus());
      }
    };

    cancelButton.addEventListener("click", () => closeAndResolve(null));
    closeButtonHandler(dialog, () => closeAndResolve(null));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!validateInput()) return;
      closeAndResolve(input.value.trim());
    });
    dialog.addEventListener("keydown", (event) => {
      trapFocus(dialog, event);
      if (event.key === "Escape") {
        event.preventDefault();
        closeAndResolve(null);
      }
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        closeAndResolve(null);
      }
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

    const closeAndResolve = (value) => {
      const previousFocus = dialog.dataset.lastFocus ? document.getElementById(dialog.dataset.lastFocus) : null;
      dialog.close();
      dialog.removeAttribute("data-last-focus");
      resolve(value);
      if (previousFocus && typeof previousFocus.focus === "function") {
        requestAnimationFrame(() => previousFocus.focus());
      }
    };

    cancelButton.addEventListener("click", () => closeAndResolve(false));
    submitButton.addEventListener("click", () => closeAndResolve(true));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      closeAndResolve(true);
    });
    dialog.addEventListener("keydown", (event) => {
      trapFocus(dialog, event);
      if (event.key === "Escape") {
        event.preventDefault();
        closeAndResolve(false);
      }
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        closeAndResolve(false);
      }
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

    const closeAndResolve = () => {
      const previousFocus = dialog.dataset.lastFocus ? document.getElementById(dialog.dataset.lastFocus) : null;
      dialog.close();
      dialog.removeAttribute("data-last-focus");
      resolve();
      if (previousFocus && typeof previousFocus.focus === "function") {
        requestAnimationFrame(() => previousFocus.focus());
      }
    };

    submitButton.addEventListener("click", closeAndResolve);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      closeAndResolve();
    });
    dialog.addEventListener("keydown", (event) => {
      trapFocus(dialog, event);
      if (event.key === "Escape") {
        event.preventDefault();
        closeAndResolve();
      }
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        closeAndResolve();
      }
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
