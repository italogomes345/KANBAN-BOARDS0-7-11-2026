"use strict";

// ESTADO E ARMAZENAMENTO
const USERS_KEY = "quadros-users-v1";
const SESSION_KEY = "quadros-session-v1";
const LEGACY_KEY = "quadros-kanban-v1";
const THEME_KEY = "quadros-theme";
const BOARD_COLORS = ["#16836d", "#db6b79", "#d49a35", "#4289bd", "#7b70bd", "#658c54"];
const PRIORITY_LABELS = { baixa: "Baixa", media: "Média", alta: "Alta" };
const elements = Object.fromEntries([
  "homeLink", "authView", "authForm", "authTitle", "authIntro", "authError", "authSubmit", "authModeToggle", "authSwitchText",
  "nameField", "nameInput", "usernameField", "usernameInput", "emailField", "emailInput", "loginIdentifier", "passwordInput",
  "togglePassword", "confirmField", "confirmPasswordInput", "toggleConfirmPassword", "userName", "logoutButton", "appView", "homeView",
  "boardView", "boardGrid", "emptyBoards", "boardTitle", "activeBoardColor", "columns", "taskSearch", "taskDialog", "taskForm",
  "taskTitleInput", "taskDescriptionInput", "taskPriorityInput", "taskDueDateInput", "taskDialogTitle", "taskError", "toast",
  "themeToggle", "themeIcon"
].map((id) => [id, document.getElementById(id)]));

let users = loadUsers();
let currentUser = null;
let state = { boards: [] };
let activeBoardId = null;
let editingTask = null;
let draggedTask = null;
let authMode = "login";
let toastTimer = null;

function loadUsers() {
  try {
    const parsed = JSON.parse(localStorage.getItem(USERS_KEY) || "{\"users\":[]}");
    return parsed && Array.isArray(parsed.users) ? parsed.users : [];
  } catch {
    return [];
  }
}

function sanitizeBoards(value) {
  if (!value || !Array.isArray(value.boards)) return { boards: [] };
  const boards = value.boards.filter((board) => board && typeof board.id === "string" && typeof board.name === "string" && Array.isArray(board.columns));
  boards.forEach((board) => {
    board.columns = board.columns.filter((column) => column && typeof column.id === "string" && typeof column.name === "string" && Array.isArray(column.tasks));
    board.columns.forEach((column) => {
      column.tasks = column.tasks.filter((task) => task && typeof task.id === "string" && typeof task.title === "string");
    });
  });
  return { boards };
}

function readLegacyBoards() {
  try {
    const saved = localStorage.getItem(LEGACY_KEY);
    return saved ? sanitizeBoards(JSON.parse(saved)) : { boards: [] };
  } catch {
    return { boards: [] };
  }
}

function saveUsers() {
  localStorage.setItem(USERS_KEY, JSON.stringify({ users }));
}

function saveState() {
  if (!currentUser) return;
  const userIndex = users.findIndex((user) => user.id === currentUser.id);
  if (userIndex < 0) return;
  users[userIndex].boards = state.boards;
  currentUser = users[userIndex];
  try {
    saveUsers();
  } catch {
    showToast("Não foi possível salvar. Verifique o espaço disponível no navegador.");
  }
}

function createId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`; }
function getActiveBoard() { return state.boards.find((board) => board.id === activeBoardId) || null; }

// LOGIN: armazenamos hash e salt, nunca a senha original.
function bytesToHex(bytes) { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(hex) { return Uint8Array.from(hex.match(/.{2}/g) || [], (part) => parseInt(part, 16)); }

async function hashPassword(password, saltHex) {
  if (!window.crypto || !window.crypto.subtle) throw new Error("Este navegador não disponibiliza a Web Crypto API nesta página.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: hexToBytes(saltHex), iterations: 250000, hash: "SHA-256" }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

function sameHash(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  elements.authTitle.textContent = registering ? "Crie sua conta" : "Entre na sua conta";
  elements.authIntro.textContent = registering ? "Cadastre-se para organizar seus quadros e tarefas." : "Acesse seus quadros e continue organizando suas tarefas.";
  elements.nameField.hidden = !registering;
  elements.usernameField.hidden = !registering;
  elements.emailField.hidden = !registering;
  elements.confirmField.hidden = !registering;
  elements.loginIdentifier.closest(".form-field").hidden = registering;
  elements.passwordInput.autocomplete = registering ? "new-password" : "current-password";
  elements.authSubmit.textContent = registering ? "Criar conta" : "Entrar";
  elements.authSwitchText.textContent = registering ? "Já tem uma conta?" : "Ainda não tem conta?";
  elements.authModeToggle.textContent = registering ? "Entrar" : "Cadastre-se";
  elements.authError.textContent = "";
}

async function registerUser(name, username, email, password) {
  const normalizedEmail = email.trim().toLocaleLowerCase("pt-BR");
  const normalizedUsername = username.trim().toLocaleLowerCase("pt-BR");
  if (users.some((user) => user.email === normalizedEmail)) throw new Error("Já existe uma conta com este e-mail.");
  if (users.some((user) => user.username && user.username.toLocaleLowerCase("pt-BR") === normalizedUsername)) throw new Error("Este nome de usuário já está em uso.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = bytesToHex(salt);
  const user = {
    id: createId(), name: name.trim(), username: normalizedUsername, email: normalizedEmail,
    salt: saltHex, passwordHash: await hashPassword(password, saltHex),
    boards: users.length === 0 ? readLegacyBoards().boards : []
  };
  users.push(user);
  try {
    saveUsers();
  } catch {
    users.pop();
    throw new Error("Não foi possível criar a conta no armazenamento deste navegador.");
  }
  if (user.boards.length > 0) {
    try { localStorage.removeItem(LEGACY_KEY); } catch { /* A cópia da conta já foi salva. */ }
  }
  await startSession(user);
}

async function loginUser(identifier, password) {
  const normalizedIdentifier = identifier.trim().toLocaleLowerCase("pt-BR");
  const user = users.find((item) => item.email === normalizedIdentifier || item.username?.toLocaleLowerCase("pt-BR") === normalizedIdentifier);
  if (!user) throw new Error("E-mail/nome de usuário ou senha incorretos.");
  const passwordHash = await hashPassword(password, user.salt);
  if (!sameHash(passwordHash, user.passwordHash)) throw new Error("E-mail/nome de usuário ou senha incorretos.");
  await startSession(user);
}

async function startSession(user) {
  try { localStorage.setItem(SESSION_KEY, user.id); }
  catch { throw new Error("Não foi possível manter a sessão neste navegador."); }
  currentUser = user;
  state = sanitizeBoards({ boards: user.boards || [] });
  elements.authView.hidden = true;
  elements.appView.hidden = false;
  elements.userName.hidden = false;
  elements.logoutButton.hidden = false;
  elements.userName.textContent = user.name;
  activeBoardId = null;
  elements.boardView.hidden = true;
  elements.homeView.hidden = false;
  renderBoards();
}

function clearSessionView() {
  currentUser = null;
  state = { boards: [] };
  activeBoardId = null;
  elements.appView.hidden = true;
  elements.userName.hidden = true;
  elements.logoutButton.hidden = true;
  elements.authView.hidden = false;
  elements.authForm.reset();
  setAuthMode("login");
}

function logoutUser() {
  saveState();
  try { localStorage.removeItem(SESSION_KEY); }
  catch { showToast("Não foi possível encerrar a sessão neste navegador."); return; }
  clearSessionView();
}

function verifyRestoredSession() {
  if (!currentUser) return;
  try {
    if (localStorage.getItem(SESSION_KEY) !== currentUser.id) clearSessionView();
  } catch {
    clearSessionView();
  }
}

function setPasswordVisibility(input, button, visibleLabel, hiddenLabel) {
  const visible = input.type === "password";
  input.type = visible ? "text" : "password";
  button.textContent = visible ? "Ocultar" : "Mostrar";
  button.setAttribute("aria-label", visible ? hiddenLabel : visibleLabel);
  button.setAttribute("aria-pressed", String(visible));
}

// KANBAN: os dados do quadro ficam no registro do usuário atual.
function createBoard(name, color = BOARD_COLORS[0]) {
  const board = {
    id: createId(), name, color,
    columns: [
      { id: createId(), name: "A Fazer", tasks: [] },
      { id: createId(), name: "Em Andamento", tasks: [] },
      { id: createId(), name: "Concluído", tasks: [] }
    ]
  };
  state.boards.push(board);
  saveState();
  renderBoards();
}

function createTask(column, title, details = {}) {
  column.tasks.push({
    id: createId(),
    title,
    description: details.description || "",
    priority: details.priority || "media",
    dueDate: details.dueDate || ""
  });
  saveState();
  renderColumns();
}

function renderBoards() {
  elements.boardGrid.replaceChildren();
  elements.emptyBoards.hidden = state.boards.length > 0;
  state.boards.forEach((board) => {
    const card = document.createElement("article");
    card.className = "board-card";
    card.style.setProperty("--board-color", board.color || BOARD_COLORS[0]);
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Abrir quadro ${board.name}`);
    card.addEventListener("click", (event) => { if (!event.target.closest(".board-card-actions")) openBoard(board.id); });
    card.addEventListener("keydown", (event) => {
      if (event.target === card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openBoard(board.id); }
    });
    const title = document.createElement("h2");
    title.className = "board-card-title";
    title.textContent = board.name;
    const meta = document.createElement("div");
    meta.className = "board-card-meta";
    const summary = document.createElement("span");
    const taskCount = board.columns.reduce((total, column) => total + column.tasks.length, 0);
    summary.textContent = `${board.columns.length} ${board.columns.length === 1 ? "coluna" : "colunas"} · ${taskCount} ${taskCount === 1 ? "tarefa" : "tarefas"}`;
    const actions = document.createElement("div");
    actions.className = "board-card-actions";
    actions.append(
      createIconButton("✎", "Renomear quadro", () => renameBoard(board)),
      createIconButton("●", "Trocar cor do quadro", () => changeBoardColor(board)),
      createIconButton("⌫", "Excluir quadro", () => deleteBoard(board), "danger-icon")
    );
    meta.append(summary, actions);
    card.append(title, meta);
    elements.boardGrid.append(card);
  });
}

function renderColumns() {
  const board = getActiveBoard();
  if (!board) return;
  elements.columns.replaceChildren();
  board.columns.forEach((column) => elements.columns.append(createColumnElement(column)));
  const addColumnButton = document.createElement("button");
  addColumnButton.type = "button";
  addColumnButton.className = "add-column-button";
  addColumnButton.textContent = "＋ Adicionar coluna";
  addColumnButton.addEventListener("click", addColumn);
  elements.columns.append(addColumnButton);
  applySearch();
}

function createColumnElement(column) {
  const section = document.createElement("section");
  section.className = "column";
  section.dataset.columnId = column.id;
  section.addEventListener("dragover", handleDragOver);
  section.addEventListener("dragleave", handleDragLeave);
  section.addEventListener("drop", handleDrop);
  const header = document.createElement("header");
  header.className = "column-header";
  const titleWrap = document.createElement("div");
  titleWrap.className = "column-title-wrap";
  const title = document.createElement("h2");
  title.className = "column-title";
  title.textContent = column.name;
  title.title = column.name;
  const count = document.createElement("span");
  count.className = "task-count";
  count.textContent = String(column.tasks.length);
  count.setAttribute("aria-label", `${column.tasks.length} tarefas`);
  titleWrap.append(title, count);
  const actions = document.createElement("div");
  actions.className = "column-actions";
  actions.append(
    createIconButton("✎", "Renomear coluna", () => renameColumn(column)),
    createIconButton("⌫", "Excluir coluna", () => deleteColumn(column), "danger-icon")
  );
  header.append(titleWrap, actions);
  const list = document.createElement("div");
  list.className = "task-list";
  list.dataset.columnId = column.id;
  list.setAttribute("aria-label", `Tarefas: ${column.name}`);
  if (column.tasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-tasks";
    empty.textContent = "Nenhuma tarefa";
    list.append(empty);
  }
  column.tasks.forEach((task) => list.append(createTaskElement(task, column.id)));
  const form = document.createElement("form");
  form.className = "add-task-form";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 120;
  input.placeholder = "Adicionar uma tarefa...";
  input.setAttribute("aria-label", `Nova tarefa em ${column.name}`);
  const addButton = document.createElement("button");
  addButton.type = "submit";
  addButton.textContent = "+";
  addButton.setAttribute("aria-label", "Adicionar tarefa");
  form.append(input, addButton);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const titleValue = input.value.trim();
    if (!titleValue) { input.focus(); return; }
    createTask(column, titleValue);
    showToast("Tarefa adicionada.");
  });
  section.append(header, list, form);
  return section;
}

function createTaskElement(task, columnId) {
  const card = document.createElement("article");
  card.className = "task-card";
  card.draggable = true;
  card.dataset.taskId = task.id;
  card.dataset.columnId = columnId;
  card.addEventListener("dragstart", handleDragStart);
  card.addEventListener("dragend", handleDragEnd);
  const title = document.createElement("h3");
  title.className = "task-card-title";
  title.textContent = task.title;
  card.append(title);
  if (task.description) {
    const description = document.createElement("p");
    description.className = "task-description";
    description.textContent = task.description;
    card.append(description);
  }
  const footer = document.createElement("div");
  footer.className = "task-footer";
  const badges = document.createElement("div");
  badges.className = "task-badges";
  const priority = document.createElement("span");
  priority.className = `badge priority-${task.priority || "media"}`;
  priority.textContent = PRIORITY_LABELS[task.priority] || PRIORITY_LABELS.media;
  badges.append(priority);
  if (task.dueDate) {
    const dueDate = document.createElement("span");
    dueDate.className = "badge due-date";
    dueDate.textContent = formatDate(task.dueDate);
    badges.append(dueDate);
  }
  const actions = document.createElement("div");
  actions.className = "task-actions";
  actions.append(createIconButton("✎", "Editar tarefa", () => openTaskModal(columnId, task)));
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "delete-task";
  deleteButton.setAttribute("aria-label", `Excluir tarefa: ${task.title}`);
  deleteButton.title = "Excluir tarefa";
  const trashIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  trashIcon.setAttribute("viewBox", "0 0 24 24");
  trashIcon.setAttribute("aria-hidden", "true");
  const trashPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  trashPath.setAttribute("d", "M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3");
  trashIcon.append(trashPath);
  deleteButton.append(trashIcon);
  deleteButton.addEventListener("click", () => deleteTask(columnId, task.id));
  actions.append(deleteButton);
  footer.append(badges, actions);
  card.append(footer);
  return card;
}

function createIconButton(symbol, label, action, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button ${extraClass}`.trim();
  button.textContent = symbol;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.addEventListener("click", (event) => { event.stopPropagation(); action(); });
  return button;
}

function openBoard(boardId) {
  activeBoardId = boardId;
  const board = getActiveBoard();
  if (!board) return;
  elements.homeView.hidden = true;
  elements.boardView.hidden = false;
  elements.boardTitle.textContent = board.name;
  elements.activeBoardColor.style.setProperty("--board-color", board.color || BOARD_COLORS[0]);
  elements.activeBoardColor.style.backgroundColor = board.color || BOARD_COLORS[0];
  elements.taskSearch.value = "";
  renderColumns();
}

function returnHome() {
  activeBoardId = null;
  elements.boardView.hidden = true;
  elements.homeView.hidden = false;
  renderBoards();
}

function goHome() {
  if (currentUser) returnHome();
  else setAuthMode("login");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renameBoard(board) {
  const name = window.prompt("Qual será o novo nome do quadro?", board.name);
  if (name === null) return;
  if (!name.trim()) { showToast("O nome do quadro não pode ficar vazio."); return; }
  board.name = name.trim();
  saveState();
  renderBoards();
  if (board.id === activeBoardId) elements.boardTitle.textContent = board.name;
}

function changeBoardColor(board) {
  const color = window.prompt(`Informe uma cor hexadecimal (ex.: ${BOARD_COLORS[0]}):`, board.color);
  if (color === null) return;
  if (!/^#[0-9a-fA-F]{6}$/.test(color.trim())) { showToast("Use uma cor hexadecimal válida, como #16836d."); return; }
  board.color = color.trim();
  saveState();
  renderBoards();
  if (board.id === activeBoardId) elements.activeBoardColor.style.backgroundColor = board.color;
}

function deleteBoard(board) {
  if (!window.confirm(`Excluir o quadro "${board.name}" e todas as suas tarefas? Esta ação não pode ser desfeita.`)) return;
  state.boards = state.boards.filter((item) => item.id !== board.id);
  saveState();
  if (activeBoardId === board.id) returnHome(); else renderBoards();
  showToast("Quadro excluído.");
}

function addColumn() {
  const name = window.prompt("Nome da nova coluna:");
  if (name === null) return;
  if (!name.trim()) { showToast("O nome da coluna não pode ficar vazio."); return; }
  getActiveBoard().columns.push({ id: createId(), name: name.trim(), tasks: [] });
  saveState();
  renderColumns();
}

function renameColumn(column) {
  const name = window.prompt("Qual será o novo nome da coluna?", column.name);
  if (name === null) return;
  if (!name.trim()) { showToast("O nome da coluna não pode ficar vazio."); return; }
  column.name = name.trim();
  saveState();
  renderColumns();
}

function deleteColumn(column) {
  if (!window.confirm(`Excluir a coluna "${column.name}" e todas as tarefas dela?`)) return;
  const board = getActiveBoard();
  board.columns = board.columns.filter((item) => item.id !== column.id);
  saveState();
  renderColumns();
  showToast("Coluna excluída.");
}

// MODAL
function openTaskModal(columnId, task = null) {
  editingTask = task ? { columnId, taskId: task.id } : { columnId, taskId: null };
  elements.taskDialogTitle.textContent = task ? "Editar tarefa" : "Adicionar tarefa";
  elements.taskTitleInput.value = task ? task.title : "";
  elements.taskDescriptionInput.value = task ? task.description || "" : "";
  elements.taskPriorityInput.value = task ? task.priority || "media" : "media";
  elements.taskDueDateInput.value = task ? task.dueDate || "" : "";
  elements.taskError.textContent = "";
  elements.taskDialog.showModal();
  elements.taskTitleInput.focus();
}

function saveTaskFromDialog(event) {
  event.preventDefault();
  if (!editingTask) return;
  const title = elements.taskTitleInput.value.trim();
  if (!title) { elements.taskError.textContent = "Informe um título para a tarefa."; elements.taskTitleInput.focus(); return; }
  const board = getActiveBoard();
  const column = board && board.columns.find((item) => item.id === editingTask.columnId);
  if (!column) return;
  const details = {
    description: elements.taskDescriptionInput.value.trim(),
    priority: elements.taskPriorityInput.value,
    dueDate: elements.taskDueDateInput.value
  };
  if (editingTask.taskId) {
    const task = column.tasks.find((item) => item.id === editingTask.taskId);
    if (task) Object.assign(task, { title, ...details });
  } else {
    column.tasks.push({ id: createId(), title, ...details });
  }
  editingTask = null;
  elements.taskDialog.close();
  saveState();
  renderColumns();
  showToast("Tarefa salva.");
}

function deleteTask(columnId, taskId) {
  const board = getActiveBoard();
  const column = board && board.columns.find((item) => item.id === columnId);
  const task = column && column.tasks.find((item) => item.id === taskId);
  if (!task || !window.confirm(`Excluir a tarefa "${task.title}"?`)) return;
  column.tasks = column.tasks.filter((item) => item.id !== taskId);
  saveState();
  renderColumns();
  showToast("Tarefa excluída.");
}

// DRAG AND DROP
function handleDragStart(event) {
  const card = event.currentTarget;
  draggedTask = { taskId: card.dataset.taskId, columnId: card.dataset.columnId };
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", card.dataset.taskId);
}

function handleDragEnd(event) {
  event.currentTarget.classList.remove("dragging");
  document.querySelectorAll(".column.drag-over").forEach((column) => column.classList.remove("drag-over"));
  draggedTask = null;
}

function handleDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  event.currentTarget.closest(".column").classList.add("drag-over");
}

function handleDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.closest(".column").classList.remove("drag-over");
}

function handleDrop(event) {
  event.preventDefault();
  const targetList = event.currentTarget;
  targetList.closest(".column").classList.remove("drag-over");
  if (!draggedTask) return;
  const board = getActiveBoard();
  const sourceColumn = board.columns.find((column) => column.id === draggedTask.columnId);
  const targetColumn = board.columns.find((column) => column.id === targetList.dataset.columnId);
  if (!sourceColumn || !targetColumn) return;
  const sourceIndex = sourceColumn.tasks.findIndex((task) => task.id === draggedTask.taskId);
  if (sourceIndex < 0) return;
  const [task] = sourceColumn.tasks.splice(sourceIndex, 1);
  const targetCard = event.target.closest(".task-card");
  let targetIndex = targetCard ? targetColumn.tasks.findIndex((item) => item.id === targetCard.dataset.taskId) : targetColumn.tasks.length;
  if (targetIndex < 0) targetIndex = targetColumn.tasks.length;
  targetColumn.tasks.splice(targetIndex, 0, task);
  saveState();
  renderColumns();
}

function applySearch() {
  const query = elements.taskSearch.value.trim().toLocaleLowerCase("pt-BR");
  document.querySelectorAll(".task-card").forEach((card) => {
    const title = card.querySelector(".task-card-title").textContent.toLocaleLowerCase("pt-BR");
    card.hidden = query.length > 0 && !title.includes(query);
  });
}

function formatDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR").format(new Date(year, month - 1, day));
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

function setTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("dark-theme", isDark);
  elements.themeIcon.textContent = isDark ? "☀" : "☾";
  elements.themeToggle.setAttribute("aria-label", isDark ? "Ativar tema claro" : "Ativar tema escuro");
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* O tema permanece ativo até fechar esta página. */ }
}

// EVENTOS E INICIALIZACAO
elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.authError.textContent = "";
  const password = elements.passwordInput.value;
  try {
    if (authMode === "register") {
      const name = elements.nameInput.value.trim();
      const username = elements.usernameInput.value.trim();
      const email = elements.emailInput.value.trim();
      if (!name) throw new Error("Informe seu nome.");
      if (!username) throw new Error("Informe um nome de usuário.");
      if (!email || !elements.emailInput.validity.valid) throw new Error("Informe um e-mail válido.");
      if (!password.trim()) throw new Error("A senha não pode ficar vazia ou conter apenas espaços.");
      if (password.length < 8) throw new Error("A senha precisa ter pelo menos 8 caracteres.");
      if (password !== elements.confirmPasswordInput.value) throw new Error("A confirmação de senha não corresponde.");
      await registerUser(name, username, email, password);
      showToast("Conta criada com sucesso.");
    } else {
      const identifier = elements.loginIdentifier.value.trim();
      if (!identifier) throw new Error("Preencha o e-mail ou nome de usuário.");
      if (!password.trim()) throw new Error("A senha não pode ficar vazia ou conter apenas espaços.");
      await loginUser(identifier, password);
    }
  } catch (error) {
    elements.authError.textContent = error.message || "Não foi possível concluir a autenticação.";
  }
});

elements.homeLink.addEventListener("click", (event) => { event.preventDefault(); goHome(); });
elements.authModeToggle.addEventListener("click", () => setAuthMode(authMode === "login" ? "register" : "login"));
elements.logoutButton.addEventListener("click", logoutUser);
elements.togglePassword.addEventListener("click", () => setPasswordVisibility(elements.passwordInput, elements.togglePassword, "Mostrar senha", "Ocultar senha"));
elements.toggleConfirmPassword.addEventListener("click", () => setPasswordVisibility(elements.confirmPasswordInput, elements.toggleConfirmPassword, "Mostrar confirmação de senha", "Ocultar confirmação de senha"));
document.getElementById("createBoardButton").addEventListener("click", () => {
  const name = window.prompt("Qual será o nome do quadro?");
  if (name === null) return;
  if (!name.trim()) { showToast("O nome do quadro não pode ficar vazio."); return; }
  createBoard(name.trim());
});
document.getElementById("backButton").addEventListener("click", returnHome);
document.getElementById("renameBoardButton").addEventListener("click", () => { const board = getActiveBoard(); if (board) renameBoard(board); });
document.getElementById("changeBoardColorButton").addEventListener("click", () => { const board = getActiveBoard(); if (board) changeBoardColor(board); });
document.getElementById("deleteBoardButton").addEventListener("click", () => { const board = getActiveBoard(); if (board) deleteBoard(board); });
document.getElementById("addTaskButton").addEventListener("click", () => {
  const board = getActiveBoard();
  if (!board || board.columns.length === 0) { showToast("Crie uma coluna antes de adicionar tarefas."); return; }
  const todoColumn = board.columns.find((column) => column.name.trim().toLocaleLowerCase("pt-BR") === "a fazer") || board.columns[0];
  openTaskModal(todoColumn.id);
});
document.getElementById("closeTaskDialog").addEventListener("click", () => elements.taskDialog.close());
document.getElementById("cancelTaskButton").addEventListener("click", () => elements.taskDialog.close());
elements.taskForm.addEventListener("submit", saveTaskFromDialog);
elements.taskDialog.addEventListener("close", () => { editingTask = null; });
elements.taskDialog.addEventListener("click", (event) => { if (event.target === elements.taskDialog) elements.taskDialog.close(); });
elements.taskTitleInput.addEventListener("input", () => { elements.taskError.textContent = ""; });
elements.taskSearch.addEventListener("input", applySearch);
elements.themeToggle.addEventListener("click", () => setTheme(document.body.classList.contains("dark-theme") ? "light" : "dark"));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && elements.taskDialog.open) { event.preventDefault(); elements.taskDialog.close(); return; }
  if (event.key === "/" && !elements.boardView.hidden && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { event.preventDefault(); elements.taskSearch.focus(); }
});
window.addEventListener("pageshow", verifyRestoredSession);
window.addEventListener("storage", (event) => {
  if (currentUser && event.key === SESSION_KEY && event.newValue !== currentUser.id) clearSessionView();
});

try { setTheme(localStorage.getItem(THEME_KEY) || "light"); } catch { setTheme("light"); }
try {
  const sessionId = localStorage.getItem(SESSION_KEY);
  const savedUser = users.find((user) => user.id === sessionId);
  if (savedUser) {
    currentUser = savedUser;
    state = sanitizeBoards({ boards: savedUser.boards || [] });
    elements.authView.hidden = true;
    elements.appView.hidden = false;
    elements.userName.hidden = false;
    elements.logoutButton.hidden = false;
    elements.userName.textContent = savedUser.name;
    renderBoards();
  }
} catch { clearSessionView(); }
