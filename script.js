import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_VERSION = "11.10.0";
const BOARDS_COLLECTION = "boards";
const LEGACY_KEYS = ["quadros-users-v1", "quadros-session-v1", "quadros-kanban-v1"];
const THEME_KEY = "quadros-theme";
const BOARD_COLORS = ["#16836d", "#db6b79", "#d49a35", "#4289bd", "#7b70bd", "#658c54"];
const PRIORITY_LABELS = { baixa: "Baixa", media: "Média", alta: "Alta" };
const MAX_BOARDS = 20;
const MAX_COLUMNS = 20;
const MAX_TASKS_PER_COLUMN = 100;
const MAX_DOCUMENT_BYTES = 800_000;

const elements = Object.fromEntries([
  "homeLink", "authView", "authForm", "authTitle", "authIntro", "authError", "authSubmit", "authModeToggle", "authSwitchText",
  "usernameField", "usernameInput", "emailField", "emailInput", "loginIdentifier", "passwordInput", "togglePassword",
  "confirmField", "confirmPasswordInput", "toggleConfirmPassword", "userName", "logoutButton", "appView", "loadingView",
  "loadingMessage", "dataErrorView", "dataErrorMessage", "retryDataButton", "homeView", "boardView", "boardGrid", "emptyBoards",
  "boardTitle", "activeBoardColor", "columns", "taskSearch", "promptDialog", "promptForm", "promptTitle", "promptDescription",
  "promptLabel", "promptInput", "promptError", "taskDialog", "taskForm", "taskTitleInput", "taskDescriptionInput",
  "taskPriorityInput", "taskDueDateInput", "taskDialogTitle", "taskError", "importDialog", "importForm",
  "legacyProfileField", "legacyProfileSelect", "importLegacyButton", "discardLegacyButton", "toast", "themeToggle", "themeIcon",
  "createBoardButton", "backButton", "renameBoardButton", "changeBoardColorButton", "deleteBoardButton", "addTaskButton",
  "closePromptDialog", "cancelPromptButton", "closeTaskDialog", "cancelTaskButton"
].map((id) => [id, document.getElementById(id)]));

let firebaseApi = null;
let auth = null;
let db = null;
let currentUser = null;
let state = { boards: [] };
let activeBoardId = null;
let editingTask = null;
let draggedTask = null;
let authMode = "login";
let toastTimer = null;
let authGeneration = 0;
let boardUnsubscribe = null;
let saveQueue = Promise.resolve();
let importChoices = [];
let importDialogResolver = null;
let dataReady = false;
let activePrompt = null;

function createId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isFirebaseConfigured() {
  const requiredValues = [firebaseConfig.apiKey, firebaseConfig.authDomain, firebaseConfig.projectId, firebaseConfig.appId];
  return requiredValues.every((value) => typeof value === "string" && value.trim() && !value.includes("COLE_AQUI"));
}

function showAuthError(message) {
  elements.authError.textContent = message;
  elements.authError.hidden = false;
}

function mapFirebaseError(error, context = "auth") {
  const code = error && error.code ? error.code : "";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found" || code === "auth/invalid-login-credentials") {
    return "E-mail ou senha incorretos.";
  }
  if (code === "auth/too-many-requests") return "Muitas tentativas. Aguarde um pouco e tente novamente.";
  if (code === "auth/network-request-failed" || !navigator.onLine) return "Falha de conexão. Verifique a internet e tente novamente.";
  if (code === "auth/email-already-in-use") return "Não foi possível criar a conta com esses dados.";
  if (code === "auth/invalid-email") return "Informe um e-mail válido.";
  if (code === "auth/weak-password") return "A senha precisa ter pelo menos 8 caracteres.";
  if (code === "auth/operation-not-allowed") return "O login por e-mail e senha ainda não foi habilitado no Firebase.";
  if (code === "permission-denied" || code === "firestore/permission-denied") return "O Firebase recusou o acesso. Confira as regras do Firestore.";
  if (context === "data") return "Não foi possível carregar ou salvar seus quadros. Tente novamente.";
  return "Não foi possível concluir a operação. Confira a configuração do Firebase e tente novamente.";
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  elements.authTitle.textContent = registering ? "Crie sua conta" : "Entre na sua conta";
  elements.authIntro.textContent = registering ? "Cadastre-se para organizar seus quadros e tarefas." : "Acesse seus quadros e continue organizando suas tarefas.";
  elements.usernameField.hidden = !registering;
  elements.emailField.hidden = !registering;
  elements.confirmField.hidden = !registering;
  elements.loginIdentifier.closest(".form-field").hidden = registering;
  elements.passwordInput.autocomplete = registering ? "new-password" : "current-password";
  elements.authSubmit.textContent = registering ? "Criar conta" : "Entrar";
  elements.authSwitchText.textContent = registering ? "Já tem uma conta?" : "Ainda não tem conta?";
  elements.authModeToggle.textContent = registering ? "Entrar" : "Cadastre-se";
  elements.authError.textContent = "";
  elements.authError.hidden = true;
}

function setPasswordVisibility(input, button, visibleLabel, hiddenLabel) {
  const visible = input.type === "password";
  input.type = visible ? "text" : "password";
  button.textContent = visible ? "Ocultar" : "Mostrar";
  button.setAttribute("aria-label", visible ? hiddenLabel : visibleLabel);
  button.setAttribute("aria-pressed", String(visible));
}

function setAuthBusy(isBusy) {
  elements.authSubmit.disabled = isBusy;
  elements.authSubmit.textContent = isBusy ? "Aguarde..." : authMode === "register" ? "Criar conta" : "Entrar";
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  elements.authError.textContent = "";
  elements.authError.hidden = true;
  const password = elements.passwordInput.value;
  const email = authMode === "register" ? elements.emailInput.value.trim() : elements.loginIdentifier.value.trim();
  if (authMode === "register") {
    if (!elements.usernameInput.value.trim()) { showAuthError("Informe um nome de usuário."); return; }
    if (elements.usernameInput.value.trim().length > 40) { showAuthError("O nome de usuário pode ter no máximo 40 caracteres."); return; }
    if (!elements.emailInput.value.trim()) { showAuthError("Informe seu e-mail."); return; }
  } else if (!email) {
    showAuthError("Informe seu e-mail.");
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showAuthError("Informe um e-mail válido."); return; }
  if (!password.trim()) { showAuthError("A senha não pode ficar vazia ou conter apenas espaços."); return; }
  if (authMode === "register" && password.length < 8) { showAuthError("A senha precisa ter pelo menos 8 caracteres."); return; }
  if (authMode === "register" && password !== elements.confirmPasswordInput.value) { showAuthError("A confirmação de senha não corresponde."); return; }
  if (!auth || !firebaseApi) {
    showAuthError("Configure o Firebase em firebase-config.js e abra o site pelo Live Server.");
    return;
  }

  setAuthBusy(true);
  try {
    if (authMode === "register") await registerUser(email, password, elements.usernameInput.value.trim());
    else await loginUser(email, password);
  } catch (error) {
    showAuthError(mapFirebaseError(error));
  } finally {
    setAuthBusy(false);
  }
}

async function registerUser(email, password, displayName) {
  if (!displayName) throw new Error("display-name-required");
  if (displayName.length > 40) throw new Error("display-name-too-long");
  if (password.length < 8) throw { code: "auth/weak-password" };
  const credentials = await firebaseApi.createUserWithEmailAndPassword(auth, email, password);
  await firebaseApi.updateProfile(credentials.user, { displayName });
  elements.userName.textContent = displayName;
}

async function loginUser(email, password) {
  await firebaseApi.signInWithEmailAndPassword(auth, email, password);
}

function showSignedOut() {
  currentUser = null;
  dataReady = false;
  stopBoardListener();
  state = { boards: [] };
  activeBoardId = null;
  elements.appView.hidden = true;
  elements.userName.hidden = true;
  elements.logoutButton.hidden = true;
  elements.authView.hidden = false;
  elements.authForm.reset();
  setAuthMode("login");
}

async function handleAuthStateChanged(user) {
  const generation = ++authGeneration;
  if (!user) {
    showSignedOut();
    return;
  }

  stopBoardListener();
  currentUser = user;
  dataReady = false;
  activeBoardId = null;
  elements.authView.hidden = true;
  elements.appView.hidden = false;
  elements.userName.hidden = false;
  elements.logoutButton.hidden = false;
  elements.userName.textContent = user.displayName || user.email || "Usuário";
  showLoading("Carregando seus quadros...");

  try {
    await loadOrCreateUserBoards(user, generation);
  } catch (error) {
    if (generation === authGeneration) showDataError(mapFirebaseError(error, "data"));
  }
}

function showLoading(message) {
  elements.loadingMessage.textContent = message;
  elements.loadingView.hidden = false;
  elements.dataErrorView.hidden = true;
  elements.homeView.hidden = true;
  elements.boardView.hidden = true;
}

function showDataError(message) {
  dataReady = false;
  elements.loadingView.hidden = true;
  elements.dataErrorView.hidden = false;
  elements.dataErrorMessage.textContent = message;
  elements.homeView.hidden = true;
  elements.boardView.hidden = true;
}

function showApp() {
  dataReady = true;
  elements.loadingView.hidden = true;
  elements.dataErrorView.hidden = true;
  elements.homeView.hidden = false;
  elements.boardView.hidden = true;
  renderBoards();
}

function handleAuthObserverError(error) {
  showSignedOut();
  showAuthError(mapFirebaseError(error));
}

async function logoutUser() {
  if (!auth || !firebaseApi) return;
  elements.logoutButton.disabled = true;
  try {
    const saveStatus = await Promise.race([
      saveQueue.then(() => "saved", () => "failed"),
      new Promise((resolve) => window.setTimeout(() => resolve("pending"), 5000))
    ]);
    if (saveStatus === "pending") showToast("Uma gravação ainda está pendente. Confira a conexão antes de continuar.");
    if (saveStatus === "failed") showToast("Uma alteração pode não ter sido salva antes de sair.");
  } catch (error) {
    showToast(mapFirebaseError(error, "data"));
  }
  try {
    await firebaseApi.signOut(auth);
  } catch (error) {
    showToast(mapFirebaseError(error));
  } finally {
    elements.logoutButton.disabled = false;
  }
}

function stopBoardListener() {
  if (boardUnsubscribe) boardUnsubscribe();
  boardUnsubscribe = null;
}

// Valida toda a estrutura antes de usar dados vindos do banco ou do navegador.
function validateBoards(boards) {
  if (!Array.isArray(boards) || boards.length > MAX_BOARDS) return null;
  for (const board of boards) {
    if (!board || typeof board.id !== "string" || board.id.length > 80) return null;
    if (typeof board.name !== "string" || !board.name.trim() || board.name.length > 100) return null;
    if (typeof board.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(board.color)) return null;
    if (!Array.isArray(board.columns) || board.columns.length > MAX_COLUMNS) return null;
    for (const column of board.columns) {
      if (!column || typeof column.id !== "string" || column.id.length > 80) return null;
      if (typeof column.name !== "string" || !column.name.trim() || column.name.length > 60) return null;
      if (!Array.isArray(column.tasks) || column.tasks.length > MAX_TASKS_PER_COLUMN) return null;
      for (const task of column.tasks) {
        if (!task || typeof task.id !== "string" || task.id.length > 80) return null;
        if (typeof task.title !== "string" || !task.title.trim() || task.title.length > 120) return null;
        if (typeof task.description !== "string" || task.description.length > 300) return null;
        if (!Object.hasOwn(PRIORITY_LABELS, task.priority)) return null;
        if (typeof task.dueDate !== "string" || (task.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate))) return null;
      }
    }
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(boards)).length > MAX_DOCUMENT_BYTES) return null;
  } catch {
    return null;
  }
  return boards;
}

function createDefaultBoards() {
  return [{
    id: createId(),
    name: "Meu quadro",
    color: BOARD_COLORS[0],
    columns: [
      { id: createId(), name: "A Fazer", tasks: [] },
      { id: createId(), name: "Em Andamento", tasks: [] },
      { id: createId(), name: "Concluído", tasks: [] }
    ]
  }];
}

function normalizeLegacyBoards(value) {
  if (!value || !Array.isArray(value.boards)) return null;
  const boards = [];
  for (const oldBoard of value.boards) {
    if (!oldBoard || typeof oldBoard.name !== "string" || !Array.isArray(oldBoard.columns)) continue;
    const columns = [];
    for (const oldColumn of oldBoard.columns) {
      if (!oldColumn || typeof oldColumn.name !== "string" || !Array.isArray(oldColumn.tasks)) continue;
      const tasks = oldColumn.tasks.filter((task) => task && typeof task.title === "string" && task.title.trim().length <= 120)
        .map((task) => ({
          id: createId(), title: task.title.trim(),
          description: typeof task.description === "string" ? task.description.slice(0, 300) : "",
          priority: Object.hasOwn(PRIORITY_LABELS, task.priority) ? task.priority : "media",
          dueDate: typeof task.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) ? task.dueDate : ""
        }));
      columns.push({ id: createId(), name: oldColumn.name.trim().slice(0, 60) || "Coluna", tasks });
    }
    boards.push({
      id: createId(), name: oldBoard.name.trim().slice(0, 100) || "Quadro importado",
      color: typeof oldBoard.color === "string" && /^#[0-9a-fA-F]{6}$/.test(oldBoard.color) ? oldBoard.color : BOARD_COLORS[0],
      columns
    });
    if (boards.length >= MAX_BOARDS) break;
  }
  return validateBoards(boards);
}

function readLegacyOptions() {
  let localUsers = [];
  let hadLocalData = false;
  try {
    hadLocalData = LEGACY_KEYS.some((key) => localStorage.getItem(key) !== null);
    const parsed = JSON.parse(localStorage.getItem("quadros-users-v1") || "null");
    if (parsed && Array.isArray(parsed.users)) localUsers = parsed.users;
  } catch {
    localUsers = [];
  }

  const profiles = localUsers.map((user, index) => {
    const boards = normalizeLegacyBoards({ boards: user && Array.isArray(user.boards) ? user.boards : [] });
    return {
      label: user && (user.name || user.username || user.email) ? String(user.name || user.username || user.email).slice(0, 80) : `Perfil local ${index + 1}`,
      boards
    };
  }).filter((profile) => profile.boards && profile.boards.length > 0);

  if (profiles.length > 0) return { profiles, hadLocalData };
  try {
    const legacy = JSON.parse(localStorage.getItem("quadros-kanban-v1") || "null");
    const boards = normalizeLegacyBoards(legacy);
    if (boards && boards.length > 0) return { profiles: [{ label: "Quadros antigos", boards }], hadLocalData };
  } catch {
    // Dados antigos malformados não impedem o login nem a criação de um quadro novo.
  }
  return { profiles: [], hadLocalData };
}

function chooseLegacyData(options) {
  if (!options.hadLocalData) return Promise.resolve({ boards: createDefaultBoards(), clearLegacy: false });
  importChoices = options.profiles;
  elements.legacyProfileField.hidden = importChoices.length < 2;
  elements.legacyProfileSelect.replaceChildren();
  importChoices.forEach((profile, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = profile.label;
    elements.legacyProfileSelect.append(option);
  });
  elements.importLegacyButton.hidden = importChoices.length === 0;
  elements.importDialog.showModal();
  return new Promise((resolve) => { importDialogResolver = resolve; });
}

function finishImportChoice(importData) {
  if (!importDialogResolver) return;
  const resolve = importDialogResolver;
  importDialogResolver = null;
  elements.importDialog.close();
  resolve(importData);
}

function clearLegacyData() {
  LEGACY_KEYS.forEach((key) => {
    try { localStorage.removeItem(key); } catch { /* A cópia confirmada no Firestore permanece intacta. */ }
  });
}

function makeDocumentData(uid, boards) {
  return { ownerUid: uid, schemaVersion: 1, boards, updatedAt: firebaseApi.serverTimestamp() };
}

function validateDocumentData(data, uid) {
  if (!data || data.ownerUid !== uid || data.schemaVersion !== 1) return null;
  return validateBoards(data.boards);
}

async function loadOrCreateUserBoards(user, generation) {
  const reference = firebaseApi.doc(db, BOARDS_COLLECTION, user.uid);
  const snapshot = await firebaseApi.getDoc(reference);
  if (generation !== authGeneration || !currentUser || currentUser.uid !== user.uid) return;

  if (snapshot.exists()) {
    const boards = validateDocumentData(snapshot.data(), user.uid);
    if (!boards) throw new Error("Os dados deste documento não correspondem ao formato suportado.");
    state = { boards };
    subscribeToUserBoards(reference, user.uid, generation);
    showApp();
    return;
  }

  const choice = await chooseLegacyData(readLegacyOptions());
  if (generation !== authGeneration || !currentUser || currentUser.uid !== user.uid) return;
  const selectedBoards = choice.boards.length > 0 ? choice.boards : createDefaultBoards();
  const validatedBoards = validateBoards(selectedBoards);
  if (!validatedBoards) throw new Error("Os dados selecionados para importar ultrapassam os limites permitidos.");
  const documentData = makeDocumentData(user.uid, validatedBoards);
  const created = await firebaseApi.runTransaction(db, async (transaction) => {
    const latest = await transaction.get(reference);
    if (latest.exists()) return false;
    transaction.set(reference, documentData);
    return true;
  });
  if (generation !== authGeneration || !currentUser || currentUser.uid !== user.uid) return;
  if (created && choice.clearLegacy) clearLegacyData();
  const savedSnapshot = await firebaseApi.getDoc(reference);
  const boards = savedSnapshot.exists() ? validateDocumentData(savedSnapshot.data(), user.uid) : null;
  if (!boards) throw new Error("Não foi possível confirmar os dados iniciais do Firestore.");
  state = { boards };
  subscribeToUserBoards(reference, user.uid, generation);
  showApp();
}

function subscribeToUserBoards(reference, uid, generation) {
  stopBoardListener();
  boardUnsubscribe = firebaseApi.onSnapshot(reference, (snapshot) => {
    if (generation !== authGeneration || !currentUser || currentUser.uid !== uid) return;
    if (!snapshot.exists()) {
      showDataError("O documento dos seus quadros não existe mais. Tente novamente.");
      return;
    }
    const boards = validateDocumentData(snapshot.data(), uid);
    if (!boards) {
      showDataError("Os dados recebidos do Firestore estão inválidos e não foram exibidos.");
      return;
    }
    state = { boards };
    if (!dataReady) showApp();
    else if (activeBoardId) renderColumns();
    else renderBoards();
  }, (error) => {
    if (generation === authGeneration) showDataError(mapFirebaseError(error, "data"));
  });
}

async function retryLoadingData() {
  if (!currentUser) return;
  const generation = authGeneration;
  showLoading("Carregando seus quadros...");
  try {
    await loadOrCreateUserBoards(currentUser, generation);
  } catch (error) {
    if (generation === authGeneration) showDataError(mapFirebaseError(error, "data"));
  }
}

async function persistState() {
  if (!currentUser || !dataReady || !db || !firebaseApi) return;
  if (!navigator.onLine) {
    showToast("Sem conexão. A alteração ainda não foi sincronizada com o Firebase.");
    return;
  }
  const boards = validateBoards(state.boards);
  if (!boards) {
    showToast("Os dados excedem os limites aceitos e não foram salvos.");
    return;
  }
  const uid = currentUser.uid;
  const capturedBoards = JSON.parse(JSON.stringify(boards));
  elements.loadingMessage.textContent = "Salvando alterações...";
  elements.loadingView.hidden = false;
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    if (!currentUser || currentUser.uid !== uid) return;
    await firebaseApi.setDoc(firebaseApi.doc(db, BOARDS_COLLECTION, uid), makeDocumentData(uid, capturedBoards));
  });
  try {
    await saveQueue;
    elements.loadingView.hidden = true;
  } catch (error) {
    elements.loadingView.hidden = true;
    showToast(mapFirebaseError(error, "data"));
  }
}

function createBoard(name, color = BOARD_COLORS[0]) {
  state.boards.push({
    id: createId(), name, color,
    columns: [
      { id: createId(), name: "A Fazer", tasks: [] },
      { id: createId(), name: "Em Andamento", tasks: [] },
      { id: createId(), name: "Concluído", tasks: [] }
    ]
  });
  renderBoards();
  void persistState();
}

function createTask(column, title, details = {}) {
  column.tasks.push({
    id: createId(), title, description: details.description || "",
    priority: details.priority || "media", dueDate: details.dueDate || ""
  });
  renderColumns();
  void persistState();
}

function renderBoards() {
  elements.boardGrid.replaceChildren();
  elements.emptyBoards.hidden = state.boards.length > 0;
  state.boards.forEach((board) => {
    const card = document.createElement("article");
    card.className = "board-card";
    card.style.setProperty("--board-color", board.color);
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
    const taskTitle = input.value.trim();
    if (!taskTitle) { input.focus(); return; }
    createTask(column, taskTitle);
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
  priority.className = `badge priority-${task.priority}`;
  priority.textContent = PRIORITY_LABELS[task.priority];
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

function getActiveBoard() { return state.boards.find((board) => board.id === activeBoardId) || null; }

function openBoard(boardId) {
  if (!dataReady || !currentUser) return;
  activeBoardId = boardId;
  const board = getActiveBoard();
  if (!board) return;
  elements.homeView.hidden = true;
  elements.boardView.hidden = false;
  elements.boardTitle.textContent = board.name;
  elements.activeBoardColor.style.backgroundColor = board.color;
  elements.taskSearch.value = "";
  renderColumns();
}

function returnHome() {
  if (!currentUser || !dataReady) return;
  activeBoardId = null;
  elements.boardView.hidden = true;
  elements.homeView.hidden = false;
  renderBoards();
}

function goHome() {
  if (currentUser && dataReady) returnHome();
  else if (!currentUser) setAuthMode("login");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renameBoard(board) {
  openPromptModal({
    title: "Renomear quadro",
    description: "Atualize o nome que aparece no seu quadro e no painel da organização.",
    label: "Nome do quadro",
    defaultValue: board.name,
    maxLength: 100,
    placeholder: "Digite o novo nome do quadro",
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > 100) return "Informe um nome com até 100 caracteres.";
      return "";
    },
    onConfirm: (value) => {
      board.name = value;
      renderBoards();
      if (board.id === activeBoardId) elements.boardTitle.textContent = board.name;
      void persistState();
    }
  });
}

function changeBoardColor(board) {
  openPromptModal({
    title: "Definir cor do quadro",
    description: `Escolha uma cor em hexadecimal para identificar este quadro. Exemplo: ${BOARD_COLORS[0]}.`,
    label: "Cor do quadro",
    defaultValue: board.color,
    maxLength: 7,
    placeholder: "#16836d",
    validate: (value) => {
      const trimmed = value.trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) return "Use uma cor hexadecimal válida, como #16836d.";
      return "";
    },
    onConfirm: (value) => {
      board.color = value;
      renderBoards();
      if (board.id === activeBoardId) elements.activeBoardColor.style.backgroundColor = board.color;
      void persistState();
    }
  });
}

function deleteBoard(board) {
  if (!window.confirm(`Excluir o quadro "${board.name}" e todas as suas tarefas? Esta ação não pode ser desfeita.`)) return;
  state.boards = state.boards.filter((item) => item.id !== board.id);
  if (activeBoardId === board.id) returnHome(); else renderBoards();
  void persistState();
  showToast("Quadro excluído.");
}

function addColumn() {
  openPromptModal({
    title: "Nova coluna",
    description: "Crie uma coluna para separar etapas do trabalho, como 'A fazer' ou 'Concluído'.",
    label: "Nome da coluna",
    placeholder: "Digite o nome da coluna",
    maxLength: 60,
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > 60) return "Informe um nome de coluna com até 60 caracteres.";
      return "";
    },
    onConfirm: (value) => {
      getActiveBoard().columns.push({ id: createId(), name: value, tasks: [] });
      renderColumns();
      void persistState();
    }
  });
}

function renameColumn(column) {
  openPromptModal({
    title: "Renomear coluna",
    description: "Atualize o título da coluna para refletir melhor a etapa atual do trabalho.",
    label: "Nome da coluna",
    defaultValue: column.name,
    maxLength: 60,
    placeholder: "Digite o novo nome da coluna",
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > 60) return "Informe um nome de coluna com até 60 caracteres.";
      return "";
    },
    onConfirm: (value) => {
      column.name = value;
      renderColumns();
      void persistState();
    }
  });
}

function deleteColumn(column) {
  if (!window.confirm(`Excluir a coluna "${column.name}" e todas as tarefas dela?`)) return;
  const board = getActiveBoard();
  board.columns = board.columns.filter((item) => item.id !== column.id);
  renderColumns();
  void persistState();
  showToast("Coluna excluída.");
}

// MODAL
function openTaskModal(columnId, task = null) {
  if (!currentUser || !dataReady) return;
  editingTask = task ? { columnId, taskId: task.id } : { columnId, taskId: null };
  elements.taskDialogTitle.textContent = task ? "Editar tarefa" : "Adicionar tarefa";
  elements.taskTitleInput.value = task ? task.title : "";
  elements.taskDescriptionInput.value = task ? task.description : "";
  elements.taskPriorityInput.value = task ? task.priority : "media";
  elements.taskDueDateInput.value = task ? task.dueDate : "";
  elements.taskError.textContent = "";
  elements.taskDialog.showModal();
  elements.taskTitleInput.focus();
}

function saveTaskFromDialog(event) {
  event.preventDefault();
  if (!currentUser || !dataReady || !editingTask) return;
  const title = elements.taskTitleInput.value.trim();
  const description = elements.taskDescriptionInput.value.trim();
  if (!title || title.length > 120) {
    elements.taskError.textContent = "Informe um título com até 120 caracteres.";
    elements.taskTitleInput.focus();
    return;
  }
  if (description.length > 300) {
    elements.taskError.textContent = "A descrição pode ter no máximo 300 caracteres.";
    elements.taskDescriptionInput.focus();
    return;
  }
  const board = getActiveBoard();
  const column = board && board.columns.find((item) => item.id === editingTask.columnId);
  if (!column) return;
  const details = { description, priority: elements.taskPriorityInput.value, dueDate: elements.taskDueDateInput.value };
  if (editingTask.taskId) {
    const task = column.tasks.find((item) => item.id === editingTask.taskId);
    if (task) Object.assign(task, { title, ...details });
  } else {
    column.tasks.push({ id: createId(), title, ...details });
  }
  editingTask = null;
  elements.taskDialog.close();
  renderColumns();
  void persistState();
  showToast("Tarefa salva.");
}

function deleteTask(columnId, taskId) {
  if (!currentUser || !dataReady) return;
  const board = getActiveBoard();
  const column = board && board.columns.find((item) => item.id === columnId);
  const task = column && column.tasks.find((item) => item.id === taskId);
  if (!task || !window.confirm(`Excluir a tarefa "${task.title}"?`)) return;
  column.tasks = column.tasks.filter((item) => item.id !== taskId);
  renderColumns();
  void persistState();
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
  const targetColumnElement = event.currentTarget.closest(".column");
  targetColumnElement.classList.remove("drag-over");
  if (!currentUser || !dataReady || !draggedTask) return;
  const board = getActiveBoard();
  const sourceColumn = board && board.columns.find((column) => column.id === draggedTask.columnId);
  const targetColumn = board && board.columns.find((column) => column.id === targetColumnElement.dataset.columnId);
  if (!sourceColumn || !targetColumn) return;
  const sourceIndex = sourceColumn.tasks.findIndex((task) => task.id === draggedTask.taskId);
  if (sourceIndex < 0) return;
  const [task] = sourceColumn.tasks.splice(sourceIndex, 1);
  const targetCard = event.target.closest(".task-card");
  let targetIndex = targetCard ? targetColumn.tasks.findIndex((item) => item.id === targetCard.dataset.taskId) : targetColumn.tasks.length;
  if (targetIndex < 0) targetIndex = targetColumn.tasks.length;
  targetColumn.tasks.splice(targetIndex, 0, task);
  renderColumns();
  void persistState();
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
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 3000);
}

function openPromptModal({ title, description, label, defaultValue = "", placeholder = "", maxLength = 100, validate = () => "", onConfirm }) {
  activePrompt = { validate, onConfirm };
  elements.promptTitle.textContent = title;
  elements.promptDescription.textContent = description || "";
  elements.promptLabel.textContent = label;
  elements.promptInput.value = defaultValue;
  elements.promptInput.placeholder = placeholder;
  elements.promptInput.maxLength = maxLength;
  elements.promptError.textContent = "";
  elements.promptDialog.showModal();
  elements.promptInput.focus();
  elements.promptInput.select();
}

function closePromptModal() {
  elements.promptDialog.close();
  elements.promptError.textContent = "";
  activePrompt = null;
}

function submitPromptModal(event) {
  event.preventDefault();
  if (!activePrompt) return;
  const value = elements.promptInput.value;
  const validationMessage = activePrompt.validate(value);
  if (validationMessage) {
    elements.promptError.textContent = validationMessage;
    elements.promptInput.focus();
    return;
  }
  activePrompt.onConfirm(value.trim());
  closePromptModal();
}

function setTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("dark-theme", isDark);
  elements.themeIcon.textContent = isDark ? "☀" : "☾";
  elements.themeToggle.setAttribute("aria-label", isDark ? "Ativar tema claro" : "Ativar tema escuro");
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* O tema permanece aplicado até fechar a página. */ }
}

function initializeImportDialog() {
  elements.importLegacyButton.addEventListener("click", () => {
    const selected = importChoices[Number(elements.legacyProfileSelect.value)] || importChoices[0];
    finishImportChoice({ boards: selected ? selected.boards : [], clearLegacy: true });
  });
  elements.discardLegacyButton.addEventListener("click", () => finishImportChoice({ boards: [], clearLegacy: true }));
  elements.importDialog.addEventListener("cancel", (event) => event.preventDefault());
}

function initializeFirebase() {
  if (!isFirebaseConfigured()) {
    showAuthError("Antes de entrar, configure seu firebaseConfig em firebase-config.js. Consulte o README.md.");
    return;
  }
  const baseUrl = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  Promise.all([
    import(`${baseUrl}/firebase-app.js`),
    import(`${baseUrl}/firebase-auth.js`),
    import(`${baseUrl}/firebase-firestore.js`)
  ]).then(async ([appSdk, authSdk, firestoreSdk]) => {
    firebaseApi = { ...authSdk, ...firestoreSdk };
    const app = appSdk.initializeApp(firebaseConfig);
    auth = authSdk.getAuth(app);
    db = firestoreSdk.getFirestore(app);
    await authSdk.setPersistence(auth, authSdk.indexedDBLocalPersistence);
    authSdk.onAuthStateChanged(auth, handleAuthStateChanged, handleAuthObserverError);
  }).catch((error) => {
    showAuthError(mapFirebaseError(error));
  });
}

// EVENTOS E INICIALIZACAO
elements.authForm.addEventListener("submit", handleAuthSubmit);
elements.authModeToggle.addEventListener("click", () => setAuthMode(authMode === "login" ? "register" : "login"));
elements.togglePassword.addEventListener("click", () => setPasswordVisibility(elements.passwordInput, elements.togglePassword, "Mostrar senha", "Ocultar senha"));
elements.toggleConfirmPassword.addEventListener("click", () => setPasswordVisibility(elements.confirmPasswordInput, elements.toggleConfirmPassword, "Mostrar confirmação de senha", "Ocultar confirmação de senha"));
elements.homeLink.addEventListener("click", (event) => { event.preventDefault(); goHome(); });
elements.logoutButton.addEventListener("click", logoutUser);
elements.retryDataButton.addEventListener("click", retryLoadingData);
elements.createBoardButton.addEventListener("click", () => {
  if (!currentUser || !dataReady) return;
  openPromptModal({
    title: "Novo quadro",
    description: "Crie um quadro para organizar ideias, tarefas e próximos passos do seu trabalho.",
    label: "Nome do quadro",
    placeholder: "Digite o nome do quadro",
    maxLength: 100,
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > 100) return "Informe um nome para o quadro com até 100 caracteres.";
      return "";
    },
    onConfirm: (value) => createBoard(value)
  });
});
elements.backButton.addEventListener("click", returnHome);
elements.renameBoardButton.addEventListener("click", () => { const board = getActiveBoard(); if (board) renameBoard(board); });
elements.changeBoardColorButton.addEventListener("click", () => { const board = getActiveBoard(); if (board) changeBoardColor(board); });
elements.deleteBoardButton.addEventListener("click", () => { const board = getActiveBoard(); if (board) deleteBoard(board); });
elements.addTaskButton.addEventListener("click", () => {
  const board = getActiveBoard();
  if (!board || board.columns.length === 0) { showToast("Crie uma coluna antes de adicionar tarefas."); return; }
  const todoColumn = board.columns.find((column) => column.name.trim().toLocaleLowerCase("pt-BR") === "a fazer") || board.columns[0];
  openTaskModal(todoColumn.id);
});
elements.closePromptDialog.addEventListener("click", closePromptModal);
elements.cancelPromptButton.addEventListener("click", closePromptModal);
elements.promptForm.addEventListener("submit", submitPromptModal);
elements.promptDialog.addEventListener("close", () => { activePrompt = null; });
elements.promptDialog.addEventListener("click", (event) => { if (event.target === elements.promptDialog) closePromptModal(); });
elements.closeTaskDialog.addEventListener("click", () => elements.taskDialog.close());
elements.cancelTaskButton.addEventListener("click", () => elements.taskDialog.close());
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
window.addEventListener("popstate", () => {
  if (!currentUser) {
    elements.appView.hidden = true;
    elements.authView.hidden = false;
  }
});
initializeImportDialog();
try { setTheme(localStorage.getItem(THEME_KEY) || "light"); } catch { setTheme("light"); }
initializeFirebase();
