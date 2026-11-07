"use strict";

const STORAGE_KEY = "quadros-kanban-v1";
const THEME_KEY = "quadros-theme";
const BOARD_COLORS = ["#635bdb", "#e36f8f", "#e6a23c", "#2f9d83", "#4686d7", "#9466c5"];
const PRIORITY_LABELS = { baixa: "Baixa", media: "Média", alta: "Alta" };

const elements = {
  homeView: document.querySelector("#homeView"),
  boardView: document.querySelector("#boardView"),
  boardGrid: document.querySelector("#boardGrid"),
  emptyBoards: document.querySelector("#emptyBoards"),
  boardTitle: document.querySelector("#boardTitle"),
  activeBoardColor: document.querySelector("#activeBoardColor"),
  columns: document.querySelector("#columns"),
  search: document.querySelector("#taskSearch"),
  taskDialog: document.querySelector("#taskDialog"),
  taskForm: document.querySelector("#taskForm"),
  taskTitleInput: document.querySelector("#taskTitleInput"),
  taskDescriptionInput: document.querySelector("#taskDescriptionInput"),
  taskPriorityInput: document.querySelector("#taskPriorityInput"),
  taskDueDateInput: document.querySelector("#taskDueDateInput"),
  taskDialogTitle: document.querySelector("#taskDialogTitle"),
  toast: document.querySelector("#toast"),
  themeToggle: document.querySelector("#themeToggle"),
  themeIcon: document.querySelector("#themeIcon")
};

let state = loadState();
let activeBoardId = null;
let editingTask = null;
let draggedTask = null;
let toastTimer = null;

// Carrega os dados salvos; se não houver dados, começa com um quadro de exemplo.
function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && Array.isArray(parsed.boards)) return parsed;
    }
  } catch (error) {
    console.error("Não foi possível carregar os quadros salvos.", error);
  }
  return { boards: [] };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("Não foi possível salvar os quadros.", error);
    showToast("Não foi possível salvar. Verifique o espaço disponível no navegador.");
  }
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function getActiveBoard() {
  return state.boards.find((board) => board.id === activeBoardId) || null;
}

function createBoard(name, color = BOARD_COLORS[0]) {
  const board = {
    id: createId(),
    name,
    color,
    columns: [
      { id: createId(), name: "A fazer", tasks: [] },
      { id: createId(), name: "Em andamento", tasks: [] },
      { id: createId(), name: "Concluído", tasks: [] }
    ]
  };
  state.boards.push(board);
  saveState();
  renderBoards();
}

function createTask(column, title, details = {}) {
  const task = {
    id: createId(),
    title,
    description: details.description || "",
    priority: details.priority || "media",
    dueDate: details.dueDate || ""
  };
  column.tasks.push(task);
  saveState();
  renderColumns();
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
    card.addEventListener("click", (event) => {
      if (!event.target.closest(".board-card-actions")) openBoard(board.id);
    });
    card.addEventListener("keydown", (event) => {
      if (event.target === card && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        openBoard(board.id);
      }
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

    const renameButton = createIconButton("✎", "Renomear quadro", () => renameBoard(board));
    const colorButton = createIconButton("●", "Trocar cor do quadro", () => changeBoardColor(board));
    const deleteButton = createIconButton("⌫", "Excluir quadro", () => deleteBoard(board));
    deleteButton.classList.add("danger-icon");
    actions.append(renameButton, colorButton, deleteButton);
    meta.append(summary, actions);
    card.append(title, meta);
    elements.boardGrid.append(card);
  });
}

function renderColumns() {
  const board = getActiveBoard();
  if (!board) return;
  elements.columns.replaceChildren();
  board.columns.forEach((column) => {
    elements.columns.append(createColumnElement(column));
  });
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
    createIconButton("⌫", "Excluir coluna", () => deleteColumn(column))
  );
  header.append(titleWrap, actions);

  const list = document.createElement("div");
  list.className = "task-list";
  list.dataset.columnId = column.id;
  list.setAttribute("aria-label", `Tarefas: ${column.name}`);
  list.addEventListener("dragover", handleDragOver);
  list.addEventListener("dragleave", handleDragLeave);
  list.addEventListener("drop", handleDrop);
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
    if (!titleValue) {
      input.focus();
      return;
    }
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
  priority.className = `badge priority-${task.priority}`;
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
  const editButton = createIconButton("✎", "Editar tarefa", () => openTaskDialog(columnId, task));
  const deleteButton = createIconButton("×", "Excluir tarefa", () => deleteTask(columnId, task.id));
  actions.append(editButton, deleteButton);
  footer.append(badges, actions);
  card.append(footer);
  return card;
}

function createIconButton(symbol, label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  button.textContent = symbol;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    action();
  });
  return button;
}

function openBoard(boardId) {
  activeBoardId = boardId;
  const board = getActiveBoard();
  if (!board) return;
  elements.homeView.hidden = true;
  elements.boardView.hidden = false;
  elements.boardTitle.textContent = board.name;
  elements.activeBoardColor.style.setProperty("--board-color", board.color);
  elements.activeBoardColor.style.backgroundColor = board.color;
  elements.search.value = "";
  renderColumns();
}

function returnHome() {
  activeBoardId = null;
  elements.boardView.hidden = true;
  elements.homeView.hidden = false;
  renderBoards();
}

function renameBoard(board) {
  const name = window.prompt("Qual será o novo nome do quadro?", board.name);
  if (name === null) return;
  if (!name.trim()) {
    showToast("O nome do quadro não pode ficar vazio.");
    return;
  }
  board.name = name.trim();
  saveState();
  renderBoards();
  if (board.id === activeBoardId) elements.boardTitle.textContent = board.name;
}

function changeBoardColor(board) {
  const color = window.prompt(`Informe uma cor hexadecimal (ex.: ${BOARD_COLORS[0]}):`, board.color);
  if (color === null) return;
  if (!/^#[0-9a-fA-F]{6}$/.test(color.trim())) {
    showToast("Use uma cor hexadecimal válida, como #635bdb.");
    return;
  }
  board.color = color.trim();
  saveState();
  renderBoards();
  if (board.id === activeBoardId) elements.activeBoardColor.style.backgroundColor = board.color;
}

function deleteBoard(board) {
  if (!window.confirm(`Excluir o quadro "${board.name}" e todas as suas tarefas? Esta ação não pode ser desfeita.`)) return;
  state.boards = state.boards.filter((item) => item.id !== board.id);
  saveState();
  if (activeBoardId === board.id) returnHome();
  else renderBoards();
  showToast("Quadro excluído.");
}

function addColumn() {
  const name = window.prompt("Nome da nova coluna:");
  if (name === null) return;
  if (!name.trim()) {
    showToast("O nome da coluna não pode ficar vazio.");
    return;
  }
  const board = getActiveBoard();
  board.columns.push({ id: createId(), name: name.trim(), tasks: [] });
  saveState();
  renderColumns();
}

function renameColumn(column) {
  const name = window.prompt("Qual será o novo nome da coluna?", column.name);
  if (name === null) return;
  if (!name.trim()) {
    showToast("O nome da coluna não pode ficar vazio.");
    return;
  }
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

function openTaskDialog(columnId, task = null) {
  editingTask = task ? { columnId, taskId: task.id } : { columnId, taskId: null };
  elements.taskDialogTitle.textContent = task ? "Editar tarefa" : "Adicionar tarefa";
  elements.taskTitleInput.value = task ? task.title : "";
  elements.taskDescriptionInput.value = task ? task.description : "";
  elements.taskPriorityInput.value = task ? task.priority : "media";
  elements.taskDueDateInput.value = task ? task.dueDate : "";
  elements.taskDialog.showModal();
  elements.taskTitleInput.focus();
}

function saveTaskFromDialog(event) {
  event.preventDefault();
  if (!editingTask) return;
  const title = elements.taskTitleInput.value.trim();
  if (!title) {
    elements.taskTitleInput.focus();
    return;
  }
  const board = getActiveBoard();
  const column = board.columns.find((item) => item.id === editingTask.columnId);
  const details = {
    description: elements.taskDescriptionInput.value.trim(),
    priority: elements.taskPriorityInput.value,
    dueDate: elements.taskDueDateInput.value
  };
  if (editingTask.taskId) {
    const task = column.tasks.find((item) => item.id === editingTask.taskId);
    if (task) Object.assign(task, { title, ...details });
  } else {
    createTask(column, title, details);
  }
  editingTask = null;
  elements.taskDialog.close();
  saveState();
  renderColumns();
  showToast("Tarefa salva.");
}

function deleteTask(columnId, taskId) {
  const board = getActiveBoard();
  const column = board.columns.find((item) => item.id === columnId);
  column.tasks = column.tasks.filter((task) => task.id !== taskId);
  saveState();
  renderColumns();
  showToast("Tarefa excluída.");
}

// A API nativa de arrastar e soltar permite reordenar e mover cartões entre colunas.
function handleDragStart(event) {
  const card = event.currentTarget;
  draggedTask = { taskId: card.dataset.taskId, columnId: card.dataset.columnId };
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", card.dataset.taskId);
}

function handleDragEnd(event) {
  event.currentTarget.classList.remove("dragging");
  document.querySelectorAll(".task-list").forEach((list) => list.classList.remove("drag-over"));
  draggedTask = null;
}

function handleDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  event.currentTarget.classList.add("drag-over");
}

function handleDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove("drag-over");
}

function handleDrop(event) {
  event.preventDefault();
  const targetList = event.currentTarget;
  targetList.classList.remove("drag-over");
  if (!draggedTask) return;

  const board = getActiveBoard();
  const sourceColumn = board.columns.find((column) => column.id === draggedTask.columnId);
  const targetColumn = board.columns.find((column) => column.id === targetList.dataset.columnId);
  if (!sourceColumn || !targetColumn) return;

  const sourceIndex = sourceColumn.tasks.findIndex((task) => task.id === draggedTask.taskId);
  if (sourceIndex < 0) return;
  const [task] = sourceColumn.tasks.splice(sourceIndex, 1);
  const targetCard = event.target.closest(".task-card");
  let targetIndex = targetCard
    ? targetColumn.tasks.findIndex((item) => item.id === targetCard.dataset.taskId)
    : targetColumn.tasks.length;
  if (targetIndex < 0) targetIndex = targetColumn.tasks.length;
  targetColumn.tasks.splice(targetIndex, 0, task);
  saveState();
  renderColumns();
}

function applySearch() {
  const query = elements.search.value.trim().toLocaleLowerCase("pt-BR");
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
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (error) {
    console.error("Não foi possível salvar a preferência de tema.", error);
  }
}

document.querySelector("#createBoardButton").addEventListener("click", () => {
  const name = window.prompt("Qual será o nome do quadro?");
  if (name === null) return;
  if (!name.trim()) {
    showToast("O nome do quadro não pode ficar vazio.");
    return;
  }
  createBoard(name.trim());
});
document.querySelector("#backButton").addEventListener("click", returnHome);
document.querySelector("#renameBoardButton").addEventListener("click", () => {
  const board = getActiveBoard();
  if (board) renameBoard(board);
});
document.querySelector("#changeBoardColorButton").addEventListener("click", () => {
  const board = getActiveBoard();
  if (board) changeBoardColor(board);
});
document.querySelector("#deleteBoardButton").addEventListener("click", () => {
  const board = getActiveBoard();
  if (board) deleteBoard(board);
});
document.querySelector("#closeTaskDialog").addEventListener("click", () => elements.taskDialog.close());
document.querySelector("#cancelTaskButton").addEventListener("click", () => elements.taskDialog.close());
elements.taskForm.addEventListener("submit", saveTaskFromDialog);
elements.taskDialog.addEventListener("close", () => { editingTask = null; });
elements.search.addEventListener("input", applySearch);
elements.themeToggle.addEventListener("click", () => {
  setTheme(document.body.classList.contains("dark-theme") ? "light" : "dark");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !elements.boardView.hidden && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    event.preventDefault();
    elements.search.focus();
  }
});

try {
  setTheme(localStorage.getItem(THEME_KEY) || "light");
} catch (error) {
  console.error("Não foi possível carregar a preferência de tema.", error);
  setTheme("light");
}
renderBoards();
