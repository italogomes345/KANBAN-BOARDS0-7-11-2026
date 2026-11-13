import { firebaseConfig } from "./firebase-config.js";
import { confirmDialog, promptDialog } from "./dialogs.js";
import * as boardData from "./board-data.js";

const FIREBASE_VERSION = "11.10.0";
const LEGACY_KEYS = ["quadros-users-v1", "quadros-session-v1", "quadros-kanban-v1"];
const THEME_KEY = "quadros-theme";
const BOARD_COLORS = ["#16836d", "#db6b79", "#d49a35", "#4289bd", "#7b70bd", "#658c54"];
const PRIORITY_LABELS = { baixa: "Baixa", media: "Média", alta: "Alta" };
const MAX_BOARDS = 20;
const MAX_COLUMNS = 20;
const MAX_TASKS_PER_COLUMN = 100;
const MAX_TASK_LIST_ITEMS = 100;

const elements = Object.fromEntries([
  "homeLink", "authView", "authForm", "authTitle", "authIntro", "authError", "authSubmit", "authModeToggle", "authSwitchText",
  "usernameField", "usernameInput", "emailField", "emailInput", "loginIdentifier", "passwordInput", "togglePassword",
  "confirmField", "confirmPasswordInput", "toggleConfirmPassword", "userName", "logoutButton", "appView", "loadingView",
  "loadingMessage", "dataErrorView", "dataErrorMessage", "retryDataButton", "homeView", "boardView", "boardGrid", "emptyBoards", "sharedBoardGrid", "emptySharedBoards",
  "boardTitle", "activeBoardColor", "columns", "taskSearch", "taskDialog", "taskForm", "taskTitleInput",
  "taskDescriptionInput", "taskPriorityInput", "taskDueDateInput", "taskDialogTitle", "taskError", "importDialog",
  "legacyProfileField", "legacyProfileSelect", "importLegacyButton", "discardLegacyButton", "toast", "themeToggle", "themeIcon",
  "createBoardButton", "backButton", "renameBoardButton", "changeBoardColorButton", "deleteBoardButton", "addTaskButton", "addSprintButton",
  "closeTaskDialog", "cancelTaskButton", "shareBoardButton", "membersDialog", "membersForm", "closeMembersDialog", "memberList",
  "inviteEmail", "inviteRole", "inviteMemberButton", "membersError", "taskPageView", "taskPageBackButton", "taskPageBoardName",
  "taskPageTitle", "taskPageDescription", "taskAssigneeInput", "taskPageDueDate", "taskPagePriority", "taskPageLabels", "taskStoryPoints",
  "taskSprint", "checklistProgress", "checklistItems", "checklistForm", "checklistInput", "acceptanceList", "acceptanceForm", "acceptanceInput",
  "commentList", "commentForm", "commentInput", "commentSubmit"
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
let activeBoardUnsubscribe = null;
let commentsUnsubscribe = null;
let saveQueue = Promise.resolve();
let importChoices = [];
let importDialogResolver = null;
let dataReady = false;
let activeTaskContext = null;

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
  if (code === "app/no-accessible-boards") return "Nenhum quadro foi encontrado para esta conta. Seus dados existentes não foram removidos; confira o console para a etapa de carga.";
  if (code === "app/concurrent-task-update") return "Esta tarefa mudou em outra sessão. Atualize o quadro antes de salvar novamente.";
  if (["auth/id-token-expired", "auth/user-token-expired", "auth/invalid-user-token", "unauthenticated"].includes(code)) {
    return "Sua sessão expirou ou deixou de ser válida. Saia da conta e entre novamente.";
  }
  if (["permission-denied", "firestore/permission-denied"].includes(code)) {
    return "Sem permissão para acessar estes quadros. Confirme se sua conta ainda é membro e tente novamente.";
  }
  if (["unavailable", "deadline-exceeded", "auth/network-request-failed"].includes(code) || !navigator.onLine) {
    return "Falha de rede ao acessar os quadros. Verifique a conexão e tente novamente.";
  }
  if (code === "failed-precondition") return "O Firestore precisa de um índice para esta consulta. Consulte o erro detalhado no console.";
  if (code === "invite/already-member") return "Este e-mail já é membro ou tem um convite pendente.";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found" || code === "auth/invalid-login-credentials") {
    return "E-mail ou senha incorretos.";
  }
  if (code === "auth/too-many-requests") return "Muitas tentativas. Aguarde um pouco e tente novamente.";
  if (code === "auth/network-request-failed") return "Falha de conexão. Verifique a internet e tente novamente.";
  if (code === "auth/email-already-in-use") return "Não foi possível criar a conta com esses dados.";
  if (code === "auth/invalid-email") return "Informe um e-mail válido.";
  if (code === "auth/weak-password") return "A senha precisa ter pelo menos 8 caracteres.";
  if (code === "auth/operation-not-allowed") return "O login por e-mail e senha ainda não foi habilitado no Firebase.";
  if (context === "data") return "Não foi possível carregar ou salvar seus quadros. Tente novamente.";
  return "Não foi possível concluir a operação. Confira a configuração do Firebase e tente novamente.";
}

function logFirebaseError(error, operation) {
  console.error(`[Firestore] ${operation} falhou`, {
    stage: error && error.boardDataStage ? error.boardDataStage : "unknown",
    code: error && error.code ? error.code : "unknown",
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : "stack unavailable"
  }, error);
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
  activeTaskContext = null;
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
    logFirebaseError(error, "initial board load");
    if (generation === authGeneration) showDataError(mapFirebaseError(error, "data"));
  }
}

function showLoading(message) {
  elements.loadingMessage.textContent = message;
  elements.loadingView.hidden = false;
  elements.dataErrorView.hidden = true;
  elements.homeView.hidden = true;
  elements.boardView.hidden = true;
  elements.taskPageView.hidden = true;
}

function showDataError(message) {
  dataReady = false;
  elements.loadingView.hidden = true;
  elements.dataErrorView.hidden = false;
  elements.dataErrorMessage.textContent = message;
  elements.homeView.hidden = true;
  elements.boardView.hidden = true;
  elements.taskPageView.hidden = true;
}

function showApp() {
  dataReady = true;
  elements.loadingView.hidden = true;
  elements.dataErrorView.hidden = true;
  elements.homeView.hidden = false;
  elements.boardView.hidden = true;
  elements.taskPageView.hidden = true;
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
  if (activeBoardUnsubscribe) activeBoardUnsubscribe();
  if (commentsUnsubscribe) commentsUnsubscribe();
  activeBoardUnsubscribe = null;
  commentsUnsubscribe = null;
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
  return boards;
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
  if (!options.hadLocalData) return Promise.resolve({ boards: [], clearLegacy: false });
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

async function loadOrCreateUserBoards(user, generation) {
  state = { boards: await boardData.loadBoards(firebaseApi, db, user, {
    selectLocalBoards: async () => {
      const options = readLegacyOptions();
      return options.hadLocalData ? chooseLegacyData(options) : { boards: [], clearLegacy: false };
    },
    onLegacyImported: clearLegacyData
  }) };
  if (generation !== authGeneration || !currentUser || currentUser.uid !== user.uid) return;
  if (!state.boards.length) throw new Error("Sua conta ainda não tem quadros acessíveis.");
  showApp();
  const taskMatch = window.location.pathname.match(/^\/tasks\/([^/]+)\/?$/);
  if (taskMatch) await openTaskPage(decodeURIComponent(taskMatch[1]));
}

function handleActiveBoardError(boardId, error) {
  logFirebaseError(error, `active board ${boardId}`);
  if (error && (error.code === "permission-denied" || error.code === "firestore/permission-denied")) {
    state.boards = state.boards.filter((board) => board.id !== boardId);
    if (activeBoardId === boardId) {
      if (activeBoardUnsubscribe) activeBoardUnsubscribe();
      if (commentsUnsubscribe) commentsUnsubscribe();
      activeBoardUnsubscribe = null;
      commentsUnsubscribe = null;
      activeBoardId = null;
      activeTaskContext = null;
      elements.boardView.hidden = true;
      elements.taskPageView.hidden = true;
      elements.homeView.hidden = false;
      renderBoards();
    }
    showToast("Seu acesso a este quadro foi removido ou alterado.");
    return;
  }
  showToast(mapFirebaseError(error, "data"));
}

async function retryLoadingData() {
  if (!currentUser) return;
  const generation = authGeneration;
  showLoading("Carregando seus quadros...");
  try {
    await loadOrCreateUserBoards(currentUser, generation);
  } catch (error) {
    logFirebaseError(error, "retry board load");
    if (generation === authGeneration) showDataError(mapFirebaseError(error, "data"));
  }
}

async function persistState(boardId = activeBoardId, taskChanges = [], saveMetadata = true) {
  if (!currentUser || !dataReady || !db || !firebaseApi) return;
  const board = state.boards.find((item) => item.id === boardId);
  if (!board || !canEditBoard(board)) return;
  if (!navigator.onLine) {
    showToast("Sem conexão. A alteração ainda não foi sincronizada com o Firebase.");
    return;
  }
  const boards = validateBoards([board]);
  if (!boards) { showToast("Os dados excedem os limites aceitos e não foram salvos."); return; }
  const uid = currentUser.uid;
  const capturedBoard = JSON.parse(JSON.stringify(boards[0]));
  elements.loadingMessage.textContent = "Salvando alterações...";
  elements.loadingView.hidden = false;
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    if (!currentUser || currentUser.uid !== uid) return;
    const latestBoard = state.boards.find((item) => item.id === boardId) || capturedBoard;
    const boardToSave = JSON.parse(JSON.stringify(latestBoard));
    const savedRevisions = await boardData.saveBoard(boardToSave, firebaseApi, db, taskChanges, saveMetadata);
    const liveBoard = state.boards.find((item) => item.id === boardId);
    if (liveBoard) {
      savedRevisions.forEach(({ taskId, revision }) => {
        const task = liveBoard.columns.flatMap((column) => column.tasks).find((item) => item.id === taskId);
        if (task) task.revision = revision;
      });
    }
  });
  try {
    await saveQueue;
    elements.loadingView.hidden = true;
  } catch (error) {
    elements.loadingView.hidden = true;
    logFirebaseError(error, "save board");
    showToast(mapFirebaseError(error, "data"));
  }
}

function createBoard(name, color = BOARD_COLORS[0]) {
  const board = {
    id: createId(), name, color, ownerUid: currentUser.uid, role: "OWNER", sprints: [], definitionOfDone: [],
    columns: [
      { id: createId(), name: "Backlog", kind: "backlog", wipLimit: null, tasks: [] },
      { id: createId(), name: "A Fazer", kind: "work", wipLimit: null, tasks: [] },
      { id: createId(), name: "Em Andamento", kind: "work", wipLimit: null, tasks: [] },
      { id: createId(), name: "Concluído", kind: "work", wipLimit: null, tasks: [] }
    ]
  };
  state.boards.push(board);
  renderBoards();
  boardData.createBoard(board, firebaseApi, db, currentUser).catch((error) => {
    logFirebaseError(error, "create board");
    state.boards = state.boards.filter((item) => item.id !== board.id);
    renderBoards();
    showToast(mapFirebaseError(error, "data"));
  });
}

function createTask(column, title, details = {}) {
  if (!canEditBoard() || column.wipLimit && column.tasks.length >= column.wipLimit) {
    showToast(column.wipLimit ? `Limite WIP atingido em "${column.name}".` : "Você não tem permissão para editar este quadro.");
    return false;
  }
  if (column.tasks.length >= MAX_TASKS_PER_COLUMN) {
    showToast(`Esta coluna atingiu o limite de ${MAX_TASKS_PER_COLUMN} tarefas.`);
    return false;
  }
  const task = {
    id: createId(), title, description: details.description || "",
    priority: details.priority || "media", dueDate: details.dueDate || "", labels: details.labels || [],
    assigneeUid: details.assigneeUid || "", assigneeName: details.assigneeName || "", checklist: details.checklist || [],
    acceptanceCriteria: details.acceptanceCriteria || [], storyPoints: details.storyPoints || 0, sprintId: details.sprintId || "", revision: 0
  };
  column.tasks.push(task);
  renderColumns();
  void persistState(activeBoardId, [{ taskId: task.id, action: "upsert" }], false);
  return true;
}

function renderBoards() {
  renderBoardCards(state.boards.filter((board) => board.ownerUid === currentUser.uid || board.role === "OWNER"), elements.boardGrid, elements.emptyBoards);
  renderBoardCards(state.boards.filter((board) => board.ownerUid !== currentUser.uid && board.role !== "OWNER"), elements.sharedBoardGrid, elements.emptySharedBoards);
  elements.createBoardButton.disabled = !currentUser;
}

function renderBoardCards(boards, container, emptyState) {
  container.replaceChildren();
  emptyState.hidden = boards.length > 0;
  boards.forEach((board) => {
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
    if (isBoardOwner(board)) {
      actions.append(
        createIconButton("✎", "Renomear quadro", () => renameBoard(board)),
        createIconButton("●", "Trocar cor do quadro", () => changeBoardColor(board)),
        createIconButton("⌫", "Excluir quadro", () => deleteBoard(board), "danger-icon")
      );
    } else {
      const role = document.createElement("span");
      role.className = "board-role-label";
      role.textContent = board.role === "VIEWER" ? "Leitor" : "Editor";
      actions.append(role);
    }
    meta.append(summary, actions);
    card.append(title, meta);
    container.append(card);
  });
}

function renderColumns() {
  const board = getActiveBoard();
  if (!board) return;
  document.querySelectorAll(".sprint-summary").forEach((item) => item.remove());
  board.sprints.forEach((sprint) => {
    const points = board.columns.flatMap((column) => column.tasks).filter((task) => task.sprintId === sprint.id)
      .reduce((total, task) => total + (task.storyPoints || 0), 0);
    const summary = document.createElement("span");
    summary.className = "sprint-summary";
    summary.textContent = `${sprint.name}: ${points} pts`;
    summary.title = `${points} story points na sprint ${sprint.name}`;
    elements.addSprintButton.parentElement.insertBefore(summary, elements.addSprintButton);
  });
  elements.columns.replaceChildren();
  board.columns.forEach((column) => elements.columns.append(createColumnElement(column)));
  const addColumnButton = document.createElement("button");
  addColumnButton.type = "button";
  addColumnButton.className = "add-column-button";
  addColumnButton.textContent = "＋ Adicionar coluna";
  addColumnButton.addEventListener("click", addColumn);
  addColumnButton.hidden = !canEditBoard(board);
  elements.columns.append(addColumnButton);
  elements.renameBoardButton.hidden = !isBoardOwner(board);
  elements.changeBoardColorButton.hidden = !isBoardOwner(board);
  elements.deleteBoardButton.hidden = !isBoardOwner(board);
  elements.shareBoardButton.hidden = false;
  elements.addSprintButton.hidden = !canEditBoard(board);
  elements.addTaskButton.hidden = !canEditBoard(board);
  applySearch();
}

function createColumnElement(column) {
  const section = document.createElement("section");
  section.className = "column";
  section.dataset.columnId = column.id;
  if (canEditBoard()) {
    section.addEventListener("dragover", handleDragOver);
    section.addEventListener("dragleave", handleDragLeave);
    section.addEventListener("drop", handleDrop);
  }
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
  const points = column.tasks.reduce((total, task) => total + (task.storyPoints || 0), 0);
  const pointsBadge = document.createElement("span");
  pointsBadge.className = "task-count story-point-total";
  pointsBadge.textContent = `${points} pts`;
  pointsBadge.setAttribute("aria-label", `${points} story points`);
  titleWrap.append(title, count, pointsBadge);
  const actions = document.createElement("div");
  actions.className = "column-actions";
  if (canEditBoard()) {
    const board = getActiveBoard();
    const index = board.columns.findIndex((item) => item.id === column.id);
    actions.append(
      createIconButton("↑", "Mover coluna para a esquerda", () => moveColumn(column, -1), "column-move"),
      createIconButton("↓", "Mover coluna para a direita", () => moveColumn(column, 1), "column-move"),
      createIconButton("↕", `Definir limite WIP${column.wipLimit ? ` (${column.wipLimit})` : ""}`, () => setColumnWipLimit(column)),
      createIconButton("✎", "Renomear coluna", () => renameColumn(column)),
      createIconButton("⌫", "Excluir coluna", () => deleteColumn(column), "danger-icon")
    );
    actions.querySelectorAll("button")[0].disabled = index <= 0;
    actions.querySelectorAll("button")[1].disabled = index >= board.columns.length - 1;
  }
  header.append(titleWrap, actions);
  if (column.wipLimit) {
    const wip = document.createElement("p");
    wip.className = "column-wip";
    wip.textContent = `WIP ${column.tasks.length}/${column.wipLimit}`;
    header.append(wip);
  }
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
  form.hidden = !canEditBoard();
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
    if (createTask(column, taskTitle)) showToast("Tarefa adicionada.");
  });
  section.append(header, list, form);
  return section;
}

function createTaskElement(task, columnId) {
  const card = document.createElement("article");
  card.className = "task-card";
  card.draggable = canEditBoard();
  card.dataset.taskId = task.id;
  card.dataset.columnId = columnId;
  if (canEditBoard()) {
    card.addEventListener("dragstart", handleDragStart);
    card.addEventListener("dragend", handleDragEnd);
  }
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
  (task.labels || []).forEach((label) => {
    const labelBadge = document.createElement("span");
    labelBadge.className = `badge task-label label-${label.toLocaleLowerCase("en-US")}`;
    labelBadge.textContent = label;
    badges.append(labelBadge);
  });
  if (task.storyPoints) {
    const points = document.createElement("span");
    points.className = "badge story-points";
    points.textContent = `${task.storyPoints} pts`;
    badges.append(points);
  }
  const actions = document.createElement("div");
  actions.className = "task-actions";
  const taskLink = document.createElement("a");
  taskLink.className = "task-open-link";
  taskLink.href = `/tasks/${encodeURIComponent(task.id)}`;
  taskLink.target = "_blank";
  taskLink.rel = "noopener";
  taskLink.setAttribute("aria-label", `Abrir tarefa ${task.title} em nova aba`);
  taskLink.title = "Abrir tarefa em nova aba";
  taskLink.textContent = "↗";
  actions.append(taskLink);
  if (canEditBoard()) actions.append(createIconButton("✎", "Editar tarefa", () => openTaskModal(columnId, task)));
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
  if (canEditBoard()) actions.append(deleteButton);
  if (task.assigneeName) {
    const assignee = document.createElement("span");
    assignee.className = "task-assignee-avatar";
    assignee.title = `Responsável: ${task.assigneeName}`;
    assignee.textContent = Array.from(task.assigneeName.trim())[0]?.toLocaleUpperCase("pt-BR") || "?";
    actions.prepend(assignee);
  }
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

function canEditBoard(board = getActiveBoard()) {
  return Boolean(board && ["OWNER", "EDITOR"].includes(board.role));
}

function isBoardOwner(board) {
  return Boolean(board && currentUser && board.ownerUid === currentUser.uid);
}

function openBoard(boardId) {
  if (!dataReady || !currentUser) return;
  if (activeBoardUnsubscribe) activeBoardUnsubscribe();
  if (commentsUnsubscribe) commentsUnsubscribe();
  activeBoardUnsubscribe = null;
  commentsUnsubscribe = null;
  activeTaskContext = null;
  activeBoardId = boardId;
  const board = getActiveBoard();
  if (!board) return;
  history.pushState({}, "", "/");
  elements.homeView.hidden = true;
  elements.boardView.hidden = false;
  elements.taskPageView.hidden = true;
  elements.boardTitle.textContent = board.name;
  elements.activeBoardColor.style.backgroundColor = board.color;
  elements.taskSearch.value = "";
  renderColumns();
  activeBoardUnsubscribe = boardData.subscribeBoard(firebaseApi, db, board.id, board.role, currentUser.uid, (updatedBoard) => {
    const index = state.boards.findIndex((item) => item.id === updatedBoard.id);
    if (index >= 0) state.boards[index] = updatedBoard;
    if (activeBoardId === updatedBoard.id) {
      if (activeTaskContext) renderTaskPage();
      else renderColumns();
    }
  }, (error) => handleActiveBoardError(board.id, error));
}

function returnHome() {
  if (!currentUser || !dataReady) return;
  if (activeBoardUnsubscribe) activeBoardUnsubscribe();
  if (commentsUnsubscribe) commentsUnsubscribe();
  activeBoardUnsubscribe = null;
  commentsUnsubscribe = null;
  activeTaskContext = null;
  activeBoardId = null;
  history.pushState({}, "", "/");
  elements.boardView.hidden = true;
  elements.taskPageView.hidden = true;
  elements.homeView.hidden = false;
  renderBoards();
}

function goHome() {
  if (currentUser && dataReady) returnHome();
  else if (!currentUser) setAuthMode("login");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function renameBoard(board) {
  if (!isBoardOwner(board)) return;
  const name = await promptDialog({
    title: "Renomear quadro",
    message: "Atualize o nome que aparece no seu quadro e no painel da organização.",
    label: "Qual será o novo nome do quadro?",
    defaultValue: board.name,
    placeholder: "Digite o novo nome do quadro",
    maxLength: 100,
    confirmText: "OK",
    cancelText: "Cancelar"
  });
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) {
    showToast("Informe um nome com até 100 caracteres.");
    return;
  }
  board.name = trimmed;
  renderBoards();
  if (board.id === activeBoardId) elements.boardTitle.textContent = board.name;
  void persistState(board.id);
}

async function changeBoardColor(board) {
  if (!isBoardOwner(board)) return;
  const color = await promptDialog({
    title: "Definir cor do quadro",
    message: `Escolha uma cor em hexadecimal para identificar este quadro. Exemplo: ${BOARD_COLORS[0]}.`,
    label: "Cor do quadro",
    defaultValue: board.color,
    placeholder: "#16836d",
    maxLength: 7,
    confirmText: "OK",
    cancelText: "Cancelar"
  });
  if (color === null) return;
  const trimmedColor = color.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(trimmedColor)) { showToast("Use uma cor hexadecimal válida, como #16836d."); return; }
  board.color = trimmedColor;
  renderBoards();
  if (board.id === activeBoardId) elements.activeBoardColor.style.backgroundColor = board.color;
  void persistState(board.id);
}

async function deleteBoard(board) {
  if (!isBoardOwner(board)) return;
  const confirmed = await confirmDialog({
    title: "Excluir quadro",
    message: `Excluir o quadro "${board.name}" e todas as suas tarefas? Esta ação não pode ser desfeita.`,
    confirmText: "Excluir",
    cancelText: "Cancelar",
    danger: true
  });
  if (!confirmed) return;
  state.boards = state.boards.filter((item) => item.id !== board.id);
  if (activeBoardId === board.id) returnHome(); else renderBoards();
  try {
    await boardData.deleteBoard(board.id, firebaseApi, db);
    showToast("Quadro excluído.");
  } catch (error) {
    logFirebaseError(error, `delete board ${board.id}`);
    showToast(mapFirebaseError(error, "data"));
    void retryLoadingData();
  }
}

async function addColumn() {
  if (!canEditBoard()) return;
  const board = getActiveBoard();
  if (!board || board.columns.length >= MAX_COLUMNS) { showToast(`Este quadro atingiu o limite de ${MAX_COLUMNS} colunas.`); return; }
  const name = await promptDialog({
    title: "Nova coluna",
    message: "Crie uma coluna para separar etapas do trabalho, como 'A fazer' ou 'Concluído'.",
    label: "Nome da coluna",
    placeholder: "Digite o nome da coluna",
    maxLength: 60,
    confirmText: "OK",
    cancelText: "Cancelar"
  });
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 60) {
    showToast("Informe um nome de coluna com até 60 caracteres.");
    return;
  }
  getActiveBoard().columns.push({ id: createId(), name: trimmed, kind: "work", wipLimit: null, tasks: [] });
  renderColumns();
  void persistState(activeBoardId);
}

async function renameColumn(column) {
  if (!canEditBoard()) return;
  const name = await promptDialog({
    title: "Renomear coluna",
    message: "Atualize o título da coluna para refletir melhor a etapa atual do trabalho.",
    label: "Qual será o novo nome da coluna?",
    defaultValue: column.name,
    placeholder: "Digite o novo nome da coluna",
    maxLength: 60,
    confirmText: "OK",
    cancelText: "Cancelar"
  });
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 60) {
    showToast("Informe um nome de coluna com até 60 caracteres.");
    return;
  }
  column.name = trimmed;
  renderColumns();
  void persistState(activeBoardId);
}

async function deleteColumn(column) {
  if (!canEditBoard()) return;
  const confirmed = await confirmDialog({
    title: "Excluir coluna",
    message: `Excluir a coluna "${column.name}" e todas as tarefas dela?`,
    confirmText: "Excluir",
    cancelText: "Cancelar",
    danger: true
  });
  if (!confirmed) return;
  const board = getActiveBoard();
  const taskChanges = column.tasks.map((task) => ({ taskId: task.id, action: "delete", revision: task.revision || 0 }));
  board.columns = board.columns.filter((item) => item.id !== column.id);
  renderColumns();
  void persistState(board.id, taskChanges, true);
  showToast("Coluna excluída.");
}

async function setColumnWipLimit(column) {
  if (!canEditBoard()) return;
  const value = await promptDialog({
    title: "Limite de trabalho em andamento",
    message: "Informe o máximo de tarefas nesta coluna. Use 0 para remover o limite.",
    label: "Quantidade máxima",
    defaultValue: String(column.wipLimit || 0),
    confirmText: "Salvar"
  });
  if (value === null) return;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0 || limit > 100) { showToast("Informe um número inteiro entre 0 e 100."); return; }
  if (limit > 0 && limit < column.tasks.length) { showToast("O limite não pode ser menor que as tarefas atuais."); return; }
  column.wipLimit = limit || null;
  renderColumns();
  void persistState(activeBoardId);
}

function moveColumn(column, direction) {
  if (!canEditBoard()) return;
  const board = getActiveBoard();
  const index = board.columns.findIndex((item) => item.id === column.id);
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= board.columns.length) return;
  [board.columns[index], board.columns[targetIndex]] = [board.columns[targetIndex], board.columns[index]];
  renderColumns();
  void persistState(board.id);
}

// MODAL
function openTaskModal(columnId, task = null) {
  if (!currentUser || !dataReady || !canEditBoard()) return;
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
  if (!currentUser || !dataReady || !editingTask || !canEditBoard()) return;
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
  let taskToSave;
  if (editingTask.taskId) {
    const task = column.tasks.find((item) => item.id === editingTask.taskId);
    if (!task) return;
    Object.assign(task, { title, ...details });
    taskToSave = task;
  } else {
    if (column.wipLimit && column.tasks.length >= column.wipLimit) {
      elements.taskError.textContent = `Limite WIP atingido em "${column.name}".`;
      return;
    }
    if (column.tasks.length >= MAX_TASKS_PER_COLUMN) {
      elements.taskError.textContent = `Esta coluna atingiu o limite de ${MAX_TASKS_PER_COLUMN} tarefas.`;
      return;
    }
    taskToSave = {
      id: createId(), title, ...details, labels: [], assigneeUid: "", assigneeName: "", checklist: [],
      acceptanceCriteria: [], storyPoints: 0, sprintId: "", revision: 0
    };
    column.tasks.push(taskToSave);
  }
  editingTask = null;
  elements.taskDialog.close();
  renderColumns();
  void persistState(board.id, [{ taskId: taskToSave.id, action: "upsert" }], false);
  showToast("Tarefa salva.");
}

async function deleteTask(columnId, taskId) {
  if (!currentUser || !dataReady || !canEditBoard()) return;
  const board = getActiveBoard();
  const column = board && board.columns.find((item) => item.id === columnId);
  const task = column && column.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const confirmed = await confirmDialog({
    title: "Excluir tarefa",
    message: `Excluir a tarefa "${task.title}"?`,
    confirmText: "Excluir",
    cancelText: "Cancelar",
    danger: true
  });
  if (!confirmed) return;
  column.tasks = column.tasks.filter((item) => item.id !== taskId);
  renderColumns();
  void persistState(activeBoardId, [{ taskId, action: "delete", revision: task.revision || 0 }], false);
  showToast("Tarefa excluída.");
}

function findTaskContext(taskId) {
  for (const board of state.boards) {
    for (const column of board.columns) {
      const task = column.tasks.find((item) => item.id === taskId);
      if (task) return { board, column, task };
    }
  }
  return null;
}

async function openTaskPage(taskId) {
  try {
    const context = findTaskContext(taskId);
    if (!context) {
      showDataError("Acesso negado. A tarefa não existe ou sua conta não é membro do quadro.");
      return;
    }
    if (activeBoardUnsubscribe) activeBoardUnsubscribe();
    if (commentsUnsubscribe) commentsUnsubscribe();
    activeBoardId = context.board.id;
    activeTaskContext = { boardId: context.board.id, taskId };
    elements.loadingView.hidden = true;
    elements.dataErrorView.hidden = true;
    elements.homeView.hidden = true;
    elements.boardView.hidden = true;
    elements.taskPageView.hidden = false;
    await loadTaskMembers(context.board);
    renderTaskPage();
    activeBoardUnsubscribe = boardData.subscribeBoard(firebaseApi, db, context.board.id, context.board.role, currentUser.uid, (updatedBoard) => {
      const index = state.boards.findIndex((item) => item.id === updatedBoard.id);
      if (index >= 0) state.boards[index] = updatedBoard;
      if (activeTaskContext && activeTaskContext.taskId === taskId) renderTaskPage();
    }, (error) => handleActiveBoardError(context.board.id, error));
    commentsUnsubscribe = boardData.subscribeComments(firebaseApi, db, context.board.id, taskId, renderComments, (error) => {
      logFirebaseError(error, `comments for task ${taskId}`);
      showToast(mapFirebaseError(error, "data"));
    });
  } catch (error) {
    logFirebaseError(error, `open task ${taskId}`);
    showDataError(mapFirebaseError(error, "data"));
  }
}

async function loadTaskMembers(board) {
  const result = await boardData.listMembers(board.id, firebaseApi, db, false);
  const select = elements.taskAssigneeInput;
  select.replaceChildren(new Option("Sem responsável", ""));
  result.members.forEach((member) => {
    const option = new Option(member.displayName || member.email || "Membro", member.userUid);
    select.append(option);
  });
}

function renderTaskPage() {
  if (!activeTaskContext) return;
  const context = findTaskContext(activeTaskContext.taskId);
  if (!context) {
    showDataError("A tarefa foi removida ou seu acesso ao quadro foi revogado.");
    return;
  }
  const { board, task } = context;
  const editable = canEditBoard(board);
  elements.taskPageTitle.textContent = task.title;
  elements.taskPageDescription.textContent = task.description || "Sem descrição.";
  elements.taskPageBoardName.textContent = board.name;
  elements.taskAssigneeInput.value = task.assigneeUid || "";
  elements.taskPageDueDate.value = task.dueDate || "";
  elements.taskPagePriority.value = task.priority || "media";
  elements.taskStoryPoints.value = String(task.storyPoints || 0);
  elements.taskSprint.replaceChildren(new Option("Sem sprint", ""));
  board.sprints.forEach((sprint) => elements.taskSprint.append(new Option(sprint.name, sprint.id)));
  elements.taskSprint.value = task.sprintId || "";
  Array.from(elements.taskPageLabels.options).forEach((option) => { option.selected = (task.labels || []).includes(option.value); });
  [elements.taskAssigneeInput, elements.taskPageDueDate, elements.taskPagePriority, elements.taskPageLabels, elements.taskStoryPoints, elements.taskSprint].forEach((control) => { control.disabled = !editable; });
  elements.checklistInput.disabled = !editable;
  elements.acceptanceInput.disabled = !editable;
  elements.commentInput.disabled = !editable;
  elements.commentSubmit.disabled = !editable;
  renderTaskChecklist(task.checklist || [], elements.checklistItems, "checklist", editable);
  renderTaskChecklist(task.acceptanceCriteria || [], elements.acceptanceList, "acceptanceCriteria", editable);
  const complete = (task.checklist || []).filter((item) => item && item.done).length;
  elements.checklistProgress.textContent = `${complete}/${(task.checklist || []).length}`;
}

function renderTaskChecklist(items, container, property, editable) {
  container.replaceChildren();
  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "checklist-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `task-${activeTaskContext.taskId}-${property}-${index}`;
    checkbox.checked = Boolean(item && item.done);
    checkbox.disabled = !editable;
    checkbox.addEventListener("change", () => {
      const context = activeTaskContext && findTaskContext(activeTaskContext.taskId);
      if (!context || !canEditBoard(context.board)) return;
      context.task[property][index].done = checkbox.checked;
      renderTaskPage();
      void persistState(context.board.id, [{ taskId: context.task.id, action: "upsert" }], false);
    });
    const text = document.createElement("label");
    text.htmlFor = checkbox.id;
    text.textContent = typeof item === "string" ? item : item.text || "";
    row.append(checkbox, text);
    if (editable) {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "checklist-remove";
      removeButton.setAttribute("aria-label", "Remover item");
      removeButton.textContent = "×";
      removeButton.addEventListener("click", () => {
        const context = activeTaskContext && findTaskContext(activeTaskContext.taskId);
        if (!context || !canEditBoard(context.board)) return;
        context.task[property].splice(index, 1);
        renderTaskPage();
        void persistState(context.board.id, [{ taskId: context.task.id, action: "upsert" }], false);
      });
      row.append(removeButton);
    }
    container.append(row);
  });
}

function addTaskListItem(event, property, input) {
  event.preventDefault();
  const context = activeTaskContext && findTaskContext(activeTaskContext.taskId);
  const text = input.value.trim();
  if (!context || !canEditBoard(context.board) || !text) return;
  if (!Array.isArray(context.task[property])) context.task[property] = [];
  if (context.task[property].length >= MAX_TASK_LIST_ITEMS) {
    showToast(`O limite de ${MAX_TASK_LIST_ITEMS} itens foi atingido.`);
    return;
  }
  context.task[property].push({ id: createId(), text, done: false });
  input.value = "";
  renderTaskPage();
  void persistState(context.board.id, [{ taskId: context.task.id, action: "upsert" }], false);
}

function updateTaskFromPage() {
  const context = activeTaskContext && findTaskContext(activeTaskContext.taskId);
  if (!context || !canEditBoard(context.board)) return;
  const points = Number(elements.taskStoryPoints.value);
  if (!Number.isInteger(points) || points < 0 || points > 100) {
    showToast("Story points deve ser um inteiro entre 0 e 100.");
    elements.taskStoryPoints.value = String(context.task.storyPoints || 0);
    return;
  }
  const assignee = elements.taskAssigneeInput.selectedOptions[0];
  context.task.assigneeUid = elements.taskAssigneeInput.value;
  context.task.assigneeName = assignee && assignee.value ? assignee.textContent : "";
  context.task.dueDate = elements.taskPageDueDate.value;
  context.task.priority = elements.taskPagePriority.value;
  context.task.labels = Array.from(elements.taskPageLabels.selectedOptions, (option) => option.value);
  context.task.storyPoints = points;
  context.task.sprintId = elements.taskSprint.value;
  renderColumns();
  void persistState(context.board.id, [{ taskId: context.task.id, action: "upsert" }], false);
}

function renderComments(comments) {
  elements.commentList.replaceChildren();
  if (!comments.length) {
    const empty = document.createElement("p");
    empty.className = "empty-comments";
    empty.textContent = "Ainda não há comentários.";
    elements.commentList.append(empty);
    return;
  }
  comments.forEach((comment) => {
    const item = document.createElement("article");
    item.className = "comment-item";
    const meta = document.createElement("div");
    meta.className = "comment-meta";
    const author = document.createElement("strong");
    author.textContent = comment.authorName || "Usuário";
    const date = document.createElement("time");
    const timestamp = comment.createdAt && typeof comment.createdAt.toDate === "function" ? comment.createdAt.toDate() : new Date();
    date.dateTime = timestamp.toISOString();
    date.textContent = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(timestamp);
    meta.append(author, date);
    const text = document.createElement("p");
    text.className = "comment-text";
    text.textContent = comment.text;
    item.append(meta, text);
    elements.commentList.append(item);
  });
}

async function submitTaskComment(event) {
  event.preventDefault();
  const text = elements.commentInput.value.trim();
  const context = activeTaskContext && findTaskContext(activeTaskContext.taskId);
  if (!context || !canEditBoard(context.board) || !text) return;
  try {
    await boardData.addComment(context.board.id, context.task.id, text, firebaseApi, db, currentUser);
    elements.commentInput.value = "";
  } catch (error) {
    logFirebaseError(error, `comment on task ${context.task.id}`);
    showToast(mapFirebaseError(error, "data"));
  }
}

async function addSprint() {
  const board = getActiveBoard();
  if (!canEditBoard(board)) return;
  if (board.sprints.length >= 30) { showToast("Este quadro atingiu o limite de 30 sprints."); return; }
  const name = await promptDialog({ title: "Nova sprint", message: "Dê um nome para o ciclo de trabalho.", label: "Nome da sprint", placeholder: "Ex.: Sprint 1", maxLength: 80, confirmText: "Criar" });
  if (!name) return;
  board.sprints.push({ id: createId(), name: name.trim() });
  void persistState(board.id);
  showToast("Sprint criada.");
}

async function openMembersDialog() {
  const board = getActiveBoard();
  if (!board) return;
  elements.membersError.textContent = "";
  elements.inviteEmail.disabled = !isBoardOwner(board);
  elements.inviteRole.disabled = !isBoardOwner(board);
  elements.inviteMemberButton.hidden = !isBoardOwner(board);
  try {
    await renderMembers(board);
    elements.membersDialog.showModal();
  } catch (error) {
    logFirebaseError(error, `load members for board ${board.id}`);
    elements.membersError.textContent = mapFirebaseError(error, "data");
    elements.membersDialog.showModal();
  }
}

async function renderMembers(board) {
  const result = await boardData.listMembers(board.id, firebaseApi, db, isBoardOwner(board));
  elements.memberList.replaceChildren();
  result.members.forEach((member) => {
    const row = document.createElement("div");
    row.className = "member-row";
    const identity = document.createElement("span");
    identity.className = "member-identity";
    identity.textContent = `${member.displayName || "Membro"}${member.email ? ` · ${member.email}` : ""}`;
    const role = document.createElement("select");
    role.className = "member-role";
    role.setAttribute("aria-label", `Papel de ${member.displayName || member.email || "membro"}`);
    ["OWNER", "EDITOR", "VIEWER"].forEach((value) => role.add(new Option(value === "OWNER" ? "Dono" : value === "EDITOR" ? "Editor" : "Leitor", value)));
    role.value = member.role;
    role.disabled = !isBoardOwner(board) || member.role === "OWNER";
    role.addEventListener("change", async () => {
      try {
        await boardData.changeMemberRole(board.id, member.userUid, role.value, firebaseApi, db);
        showToast("Papel atualizado.");
      } catch (error) {
        logFirebaseError(error, `change member role on board ${board.id}`);
        role.value = member.role;
        showToast(mapFirebaseError(error, "data"));
      }
    });
    row.append(identity, role);
    if (isBoardOwner(board) && member.role !== "OWNER") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-button small member-remove danger-icon";
      remove.textContent = "×";
      remove.title = "Remover acesso";
      remove.setAttribute("aria-label", `Remover acesso de ${member.displayName || member.email || "membro"}`);
      remove.addEventListener("click", async () => {
        const confirmed = await confirmDialog({ title: "Remover membro", message: `Remover o acesso de ${member.displayName || member.email || "este membro"}?`, confirmText: "Remover", danger: true });
        if (!confirmed) return;
        try {
          await boardData.removeMember(board.id, member.userUid, firebaseApi, db);
          await renderMembers(board);
          showToast("Acesso removido.");
        } catch (error) {
          logFirebaseError(error, `remove member from board ${board.id}`);
          showToast(mapFirebaseError(error, "data"));
        }
      });
      row.append(remove);
    }
    elements.memberList.append(row);
  });
  result.invites.forEach((invite) => {
    const row = document.createElement("div");
    row.className = "member-row pending-invite";
    const identity = document.createElement("span");
    identity.className = "member-identity";
    identity.textContent = `${invite.email} · convite pendente`;
    const role = document.createElement("span");
    role.className = "member-role-label";
    role.textContent = invite.role === "VIEWER" ? "Leitor" : "Editor";
    row.append(identity, role);
    if (isBoardOwner(board)) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "icon-button small member-remove danger-icon";
      cancel.textContent = "×";
      cancel.title = "Cancelar convite";
      cancel.setAttribute("aria-label", `Cancelar convite para ${invite.email}`);
      cancel.addEventListener("click", async () => {
        try {
          await firebaseApi.deleteDoc(firebaseApi.doc(db, "boardInvites", invite.id));
          await renderMembers(board);
          showToast("Convite cancelado.");
        } catch (error) {
          logFirebaseError(error, `cancel invite ${invite.id}`);
          showToast(mapFirebaseError(error, "data"));
        }
      });
      row.append(cancel);
    }
    elements.memberList.append(row);
  });
}

async function inviteBoardMember() {
  const board = getActiveBoard();
  if (!isBoardOwner(board)) return;
  const email = elements.inviteEmail.value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    elements.membersError.textContent = "Informe um e-mail válido.";
    elements.inviteEmail.focus();
    return;
  }
  if (email === (currentUser.email || "").toLowerCase()) {
    elements.membersError.textContent = "Você já é o dono deste quadro.";
    return;
  }
  elements.inviteMemberButton.disabled = true;
  try {
    await boardData.inviteMember(board.id, email, elements.inviteRole.value, firebaseApi, db, currentUser);
    elements.inviteEmail.value = "";
    elements.membersError.textContent = "";
    await renderMembers(board);
    showToast("Convite pendente registrado. O acesso será ativado quando a pessoa entrar com este e-mail.");
  } catch (error) {
    logFirebaseError(error, `invite ${email} to board ${board.id}`);
    elements.membersError.textContent = mapFirebaseError(error, "data");
  } finally {
    elements.inviteMemberButton.disabled = false;
  }
}

// DRAG AND DROP
function handleDragStart(event) {
  if (!canEditBoard()) { event.preventDefault(); return; }
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
  if (!currentUser || !dataReady || !draggedTask || !canEditBoard()) return;
  const board = getActiveBoard();
  const sourceColumn = board && board.columns.find((column) => column.id === draggedTask.columnId);
  const targetColumn = board && board.columns.find((column) => column.id === targetColumnElement.dataset.columnId);
  if (!sourceColumn || !targetColumn) return;
  const sourceIndex = sourceColumn.tasks.findIndex((task) => task.id === draggedTask.taskId);
  if (sourceIndex < 0) return;
  if (sourceColumn !== targetColumn && targetColumn.wipLimit && targetColumn.tasks.length >= targetColumn.wipLimit) {
    showToast(`Limite WIP atingido em "${targetColumn.name}".`);
    return;
  }
  const [task] = sourceColumn.tasks.splice(sourceIndex, 1);
  const targetCard = event.target.closest(".task-card");
  let targetIndex = targetCard ? targetColumn.tasks.findIndex((item) => item.id === targetCard.dataset.taskId) : targetColumn.tasks.length;
  if (targetIndex < 0) targetIndex = targetColumn.tasks.length;
  targetColumn.tasks.splice(targetIndex, 0, task);
  renderColumns();
  void persistState(board.id, [{ taskId: task.id, action: "upsert" }], false);
}

function applySearch() {
  const query = elements.taskSearch.value.trim().toLocaleLowerCase("pt-BR");
  document.querySelectorAll(".task-card").forEach((card) => {
    const title = card.querySelector(".task-card-title").textContent.toLocaleLowerCase("pt-BR");
    card.hidden = query.length > 0 && !title.includes(query);
  });
}

function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return value;
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(date);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 3000);
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
    logFirebaseError(error, "initialize Firebase");
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
elements.createBoardButton.addEventListener("click", async () => {
  if (!currentUser || !dataReady) return;
  const name = await promptDialog({
    title: "Novo quadro",
    message: "Crie um quadro para organizar ideias, tarefas e próximos passos do seu trabalho.",
    label: "Qual será o nome do quadro?",
    placeholder: "Digite o nome do quadro",
    maxLength: 100,
    confirmText: "OK",
    cancelText: "Cancelar"
  });
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) {
    showToast("Informe um nome para o quadro com até 100 caracteres.");
    return;
  }
  createBoard(trimmed);
});
elements.backButton.addEventListener("click", returnHome);
elements.renameBoardButton.addEventListener("click", () => { const board = getActiveBoard(); if (board) renameBoard(board); });
elements.changeBoardColorButton.addEventListener("click", () => { const board = getActiveBoard(); if (board) changeBoardColor(board); });
elements.deleteBoardButton.addEventListener("click", () => { const board = getActiveBoard(); if (board) deleteBoard(board); });
elements.addTaskButton.addEventListener("click", () => {
  const board = getActiveBoard();
  if (!canEditBoard(board)) return;
  if (!board || board.columns.length === 0) { showToast("Crie uma coluna antes de adicionar tarefas."); return; }
  const todoColumn = board.columns.find((column) => column.name.trim().toLocaleLowerCase("pt-BR") === "a fazer") || board.columns[0];
  openTaskModal(todoColumn.id);
});
elements.shareBoardButton.addEventListener("click", openMembersDialog);
elements.addSprintButton.addEventListener("click", addSprint);
elements.closeTaskDialog.addEventListener("click", () => elements.taskDialog.close());
elements.cancelTaskButton.addEventListener("click", () => elements.taskDialog.close());
elements.taskForm.addEventListener("submit", saveTaskFromDialog);
elements.taskDialog.addEventListener("close", () => { editingTask = null; });
elements.taskDialog.addEventListener("click", (event) => { if (event.target === elements.taskDialog) elements.taskDialog.close(); });
elements.taskTitleInput.addEventListener("input", () => { elements.taskError.textContent = ""; });
elements.closeMembersDialog.addEventListener("click", () => elements.membersDialog.close());
elements.membersForm.addEventListener("submit", (event) => event.preventDefault());
elements.inviteMemberButton.addEventListener("click", inviteBoardMember);
elements.membersDialog.addEventListener("click", (event) => { if (event.target === elements.membersDialog) elements.membersDialog.close(); });
elements.taskPageBackButton.addEventListener("click", () => {
  if (activeBoardId) openBoard(activeBoardId);
  else returnHome();
});
elements.checklistForm.addEventListener("submit", (event) => addTaskListItem(event, "checklist", elements.checklistInput));
elements.acceptanceForm.addEventListener("submit", (event) => addTaskListItem(event, "acceptanceCriteria", elements.acceptanceInput));
elements.commentForm.addEventListener("submit", submitTaskComment);
[elements.taskAssigneeInput, elements.taskPageDueDate, elements.taskPagePriority, elements.taskPageLabels, elements.taskStoryPoints, elements.taskSprint]
  .forEach((control) => control.addEventListener("change", updateTaskFromPage));
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
    return;
  }
  const taskMatch = window.location.pathname.match(/^\/tasks\/([^/]+)\/?$/);
  if (taskMatch) { void openTaskPage(decodeURIComponent(taskMatch[1])); return; }
  if (activeTaskContext || activeBoardId) returnHome();
});
initializeImportDialog();
try { setTheme(localStorage.getItem(THEME_KEY) || "light"); } catch { setTheme("light"); }
initializeFirebase();
