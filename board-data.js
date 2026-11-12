const BOARD_COLLECTION = "boards";
const MEMBER_COLLECTION = "members";
const TASK_COLLECTION = "tasks";
const INVITE_COLLECTION = "boardInvites";
const MIGRATION_COLLECTION = "userMigrations";
const PRIORITIES = new Set(["baixa", "media", "alta"]);

async function runStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    const wrapped = new Error(error && error.message ? error.message : String(error), { cause: error });
    wrapped.code = error && error.code ? error.code : "unknown";
    wrapped.boardDataStage = stage;
    wrapped.stack = error && error.stack ? error.stack : wrapped.stack;
    throw wrapped;
  }
}

function createId(api) {
  return api.doc(api.collection(api.getFirestore(), "_ids")).id;
}

function normalizeTask(task, columnId) {
  return {
    id: typeof task.id === "string" ? task.id : crypto.randomUUID(),
    columnId,
    title: String(task.title || "Tarefa").trim().slice(0, 120),
    description: typeof task.description === "string" ? task.description.slice(0, 300) : "",
    priority: PRIORITIES.has(task.priority) ? task.priority : "media",
    dueDate: typeof task.dueDate === "string" ? task.dueDate : "",
    assigneeUid: typeof task.assigneeUid === "string" ? task.assigneeUid : "",
    assigneeName: typeof task.assigneeName === "string" ? task.assigneeName : "",
    labels: Array.isArray(task.labels) ? task.labels.filter((label) => ["Bug", "Feature", "Urgente"].includes(label)) : [],
    checklist: Array.isArray(task.checklist) ? task.checklist : [],
    acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [],
    storyPoints: Number.isInteger(task.storyPoints) ? Math.min(100, Math.max(0, task.storyPoints)) : 0,
    sprintId: typeof task.sprintId === "string" ? task.sprintId : ""
  };
}

function normalizeBoard(source, ownerUid, api, role = "OWNER") {
  const columns = Array.isArray(source.columns) ? source.columns.slice(0, 20).map((column) => {
    const columnId = typeof column.id === "string" ? column.id : api.doc(api.collection(api.getFirestore(), "_ids")).id;
    return {
      id: columnId,
      name: String(column.name || "Coluna").trim().slice(0, 60),
      wipLimit: Number.isInteger(column.wipLimit) && column.wipLimit > 0 ? column.wipLimit : null,
      kind: column.kind === "backlog" ? "backlog" : "work",
      tasks: Array.isArray(column.tasks) ? column.tasks.map((task) => normalizeTask(task, columnId)) : []
    };
  }) : [];
  if (!columns.some((column) => column.kind === "backlog")) {
    columns.unshift({ id: api.doc(api.collection(api.getFirestore(), "_ids")).id, name: "Backlog", wipLimit: null, kind: "backlog", tasks: [] });
  }
  return {
    id: typeof source.id === "string" ? source.id : api.doc(api.collection(api.getFirestore(), "_ids")).id,
    name: String(source.name || "Meu quadro").trim().slice(0, 100),
    color: /^#[0-9a-fA-F]{6}$/.test(source.color) ? source.color : "#16836d",
    ownerUid,
    role,
    columns,
    sprints: Array.isArray(source.sprints) ? source.sprints.slice(0, 30) : [],
    definitionOfDone: Array.isArray(source.definitionOfDone) ? source.definitionOfDone.slice(0, 30) : []
  };
}

function defaultBoard(user, api) {
  return normalizeBoard({
    name: "Meu quadro",
    color: "#16836d",
    columns: [
      { name: "Backlog", kind: "backlog", tasks: [] },
      { name: "A Fazer", tasks: [] },
      { name: "Em Andamento", tasks: [] },
      { name: "Concluído", tasks: [] }
    ]
  }, user.uid, api);
}

function boardDocument(board, api) {
  return {
    id: board.id,
    ownerUid: board.ownerUid,
    schemaVersion: 2,
    name: board.name,
    color: board.color,
    columns: board.columns.map(({ id, name, wipLimit, kind }) => ({ id, name, wipLimit: wipLimit || 0, kind })),
    sprints: board.sprints,
    definitionOfDone: board.definitionOfDone,
    updatedAt: api.serverTimestamp()
  };
}

function taskDocument(board, column, task, api) {
  const { id, ...fields } = task;
  return { ...fields, id, boardId: board.id, columnId: column.id, updatedAt: api.serverTimestamp() };
}

function assembleBoard(snapshot, taskSnapshots, role) {
  const data = snapshot.data();
  const board = {
    id: snapshot.id,
    ownerUid: data.ownerUid,
    role,
    name: data.name,
    color: data.color,
    columns: (data.columns || []).map((column) => ({ ...column, wipLimit: column.wipLimit || null, tasks: [] })),
    sprints: data.sprints || [],
    definitionOfDone: data.definitionOfDone || []
  };
  const columnsById = new Map(board.columns.map((column) => [column.id, column]));
  taskSnapshots.forEach((taskSnapshot) => {
    const task = { ...taskSnapshot.data(), id: taskSnapshot.id };
    const column = columnsById.get(task.columnId);
    if (column) column.tasks.push(normalizeTask(task, column.id));
  });
  return board;
}

async function writeBoardAndOwner(board, api, db, user) {
  const boardRef = api.doc(db, BOARD_COLLECTION, board.id);
  await api.setDoc(boardRef, boardDocument(board, api));
  await ensureOwnerMembership(boardRef, api, db, user);
  await saveBoard(board, api, db);
}

async function ensureOwnerMembership(boardRef, api, db, user) {
  const memberRef = api.doc(boardRef, MEMBER_COLLECTION, user.uid);
  if ((await api.getDoc(memberRef)).exists()) return;
  await api.setDoc(memberRef, {
    userUid: user.uid,
    email: user.email || "",
    displayName: user.displayName || user.email || "Proprietário",
    role: "OWNER",
    createdAt: api.serverTimestamp()
  });
}

async function migrateLegacyBoards(api, db, user, createDefault, selectLocalBoards) {
  const migrationRef = api.doc(db, MIGRATION_COLLECTION, user.uid);
  const migrationSnapshot = await api.getDoc(migrationRef);

  const legacyRef = api.doc(db, BOARD_COLLECTION, user.uid);
  const legacySnapshot = await api.getDoc(legacyRef);
  const legacyBoards = legacySnapshot.exists() && legacySnapshot.data().schemaVersion === 1
    ? legacySnapshot.data().boards
    : [];
  if (migrationSnapshot.exists() && (!Array.isArray(legacyBoards) || legacyBoards.length === 0) && !createDefault) return false;
  const localSelection = Array.isArray(legacyBoards) && legacyBoards.length ? { boards: [], clearLegacy: false }
    : createDefault && selectLocalBoards ? await selectLocalBoards() : { boards: [], clearLegacy: false };
  const boards = Array.isArray(legacyBoards) && legacyBoards.length
    ? legacyBoards.map((board) => normalizeBoard(board, user.uid, api))
    : Array.isArray(localSelection.boards) && localSelection.boards.length
      ? localSelection.boards.map((board) => normalizeBoard(board, user.uid, api))
      : createDefault ? [defaultBoard(user, api)] : [];

  for (const board of boards) {
    const boardRef = api.doc(db, BOARD_COLLECTION, board.id);
    const existing = await api.getDoc(boardRef);
    if (existing.exists()) {
      if (existing.data().ownerUid !== user.uid || existing.data().schemaVersion !== 2) {
        throw new Error(`O quadro legado ${board.id} colide com um documento existente; nenhum dado foi sobrescrito.`);
      }
      await ensureOwnerMembership(boardRef, api, db, user);
    } else {
      await writeBoardAndOwner(board, api, db, user);
    }
  }
  if (!migrationSnapshot.exists()) await api.setDoc(migrationRef, { completedAt: api.serverTimestamp(), schemaVersion: 2 });
  return localSelection.clearLegacy;
}

async function acceptInvites(api, db, user) {
  if (!user.email) return;
  const inviteQuery = api.query(
    api.collection(db, INVITE_COLLECTION),
    api.where("email", "==", user.email.toLowerCase())
  );
  const inviteSnapshots = (await api.getDocs(inviteQuery)).docs.filter((snapshot) => snapshot.data().status === "pending");
  for (const inviteSnapshot of inviteSnapshots) {
    const invite = inviteSnapshot.data();
    const boardRef = api.doc(db, BOARD_COLLECTION, invite.boardId);
    if (!(await api.getDoc(boardRef)).exists()) continue;
    const memberRef = api.doc(boardRef, MEMBER_COLLECTION, user.uid);
    if (!(await api.getDoc(memberRef)).exists()) {
      await api.setDoc(memberRef, {
        userUid: user.uid,
        email: user.email,
        displayName: user.displayName || user.email,
        role: invite.role,
        inviteId: inviteSnapshot.id,
        createdAt: api.serverTimestamp()
      });
    }
    await api.updateDoc(inviteSnapshot.ref, { status: "accepted", acceptedUid: user.uid });
  }
}

async function readBoard(api, db, boardId, role) {
  const boardRef = api.doc(db, BOARD_COLLECTION, boardId);
  const boardSnapshot = await api.getDoc(boardRef);
  if (!boardSnapshot.exists() || boardSnapshot.data().schemaVersion !== 2) return null;
  const taskSnapshots = await api.getDocs(api.collection(boardRef, TASK_COLLECTION));
  return assembleBoard(boardSnapshot, taskSnapshots.docs, role);
}

export async function loadBoards(api, db, user, options = {}) {
  await runStage("accept invites", () => acceptInvites(api, db, user));
  const ownerQuery = api.query(api.collection(db, BOARD_COLLECTION), api.where("ownerUid", "==", user.uid));
  const ownerSnapshots = await runStage("list owned boards", () => api.getDocs(ownerQuery));
  const ownedIds = new Set(ownerSnapshots.docs.filter((snapshot) => snapshot.data().schemaVersion === 2).map((snapshot) => snapshot.id));

  await runStage("repair owner memberships", async () => {
    for (const snapshot of ownerSnapshots.docs) {
      if (snapshot.data().schemaVersion !== 2) continue;
      const ownerMembership = api.doc(db, BOARD_COLLECTION, snapshot.id, MEMBER_COLLECTION, user.uid);
      if ((await api.getDoc(ownerMembership)).exists()) continue;
      await api.setDoc(ownerMembership, {
        userUid: user.uid,
        email: user.email || "",
        displayName: user.displayName || user.email || "Proprietário",
        role: "OWNER",
        createdAt: api.serverTimestamp()
      });
    }
  });

  const memberQuery = api.query(api.collectionGroup(db, MEMBER_COLLECTION), api.where("userUid", "==", user.uid));
  const memberSnapshots = await runStage("list board memberships", () => api.getDocs(memberQuery));
  const roles = new Map();
  memberSnapshots.docs.forEach((snapshot) => {
    const boardRef = snapshot.ref.parent.parent;
    if (boardRef) roles.set(boardRef.id, snapshot.data().role);
  });

  if (ownedIds.size === 0 && roles.size === 0) {
    const clearLegacy = await runStage("migrate legacy boards", () => migrateLegacyBoards(api, db, user, true, options.selectLocalBoards));
    if (clearLegacy && options.onLegacyImported) options.onLegacyImported();
  } else {
    const migrationRef = api.doc(db, MIGRATION_COLLECTION, user.uid);
    if (!(await runStage("check migration marker", () => api.getDoc(migrationRef))).exists()) {
      await runStage("migrate legacy boards", () => migrateLegacyBoards(api, db, user, false));
    }
  }

  const refreshedOwners = await runStage("refresh owned boards", () => api.getDocs(ownerQuery));
  refreshedOwners.docs.forEach((snapshot) => {
    if (snapshot.data().schemaVersion === 2) roles.set(snapshot.id, "OWNER");
  });
  const refreshedMembers = await runStage("refresh board memberships", () => api.getDocs(memberQuery));
  refreshedMembers.docs.forEach((snapshot) => {
    const boardRef = snapshot.ref.parent.parent;
    if (boardRef && !roles.has(boardRef.id)) roles.set(boardRef.id, snapshot.data().role);
  });

  const boards = await Promise.all(Array.from(roles, ([boardId, role]) =>
    runStage(`read board ${boardId}`, () => readBoard(api, db, boardId, role))));
  const accessibleBoards = boards.filter(Boolean);
  if (accessibleBoards.length === 0) {
    const error = new Error("Nenhum quadro acessível foi encontrado depois da consulta e da migração.");
    error.code = "app/no-accessible-boards";
    error.boardDataStage = "resolve board memberships";
    throw error;
  }
  return accessibleBoards;
}

export async function createBoard(board, api, db, user) {
  await writeBoardAndOwner(board, api, db, user);
}

export async function saveBoard(board, api, db) {
  const boardRef = api.doc(db, BOARD_COLLECTION, board.id);
  await api.updateDoc(boardRef, boardDocument(board, api));
  const taskCollection = api.collection(boardRef, TASK_COLLECTION);
  const existing = await api.getDocs(taskCollection);
  const liveTasks = new Map();
  board.columns.forEach((column) => column.tasks.forEach((task) => liveTasks.set(task.id, { task, column })));
  const removedTasks = existing.docs.filter((taskSnapshot) => !liveTasks.has(taskSnapshot.id));
  const operations = [];
  for (const taskSnapshot of removedTasks) {
    const comments = await api.getDocs(api.collection(taskSnapshot.ref, "comments"));
    comments.docs.forEach((comment) => operations.push({ type: "delete", ref: comment.ref }));
    operations.push({ type: "delete", ref: taskSnapshot.ref });
  }
  operations.push(...Array.from(liveTasks, ([taskId, { task, column }]) => ({
    type: "set", ref: api.doc(taskCollection, taskId), data: taskDocument(board, column, task, api)
  })));
  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = api.writeBatch(db);
    operations.slice(offset, offset + 400).forEach((operation) => {
      if (operation.type === "delete") batch.delete(operation.ref);
      else batch.set(operation.ref, operation.data);
    });
    await batch.commit();
  }
}

export async function deleteBoard(boardId, api, db) {
  const boardRef = api.doc(db, BOARD_COLLECTION, boardId);
  const [boardSnapshot, tasks, members, activities] = await Promise.all([
    api.getDoc(boardRef),
    api.getDocs(api.collection(boardRef, TASK_COLLECTION)),
    api.getDocs(api.collection(boardRef, MEMBER_COLLECTION)),
    api.getDocs(api.collection(boardRef, "activity"))
  ]);
  const ownerUid = boardSnapshot.exists() ? boardSnapshot.data().ownerUid : "";
  for (const taskSnapshot of tasks.docs) {
    const comments = await api.getDocs(api.collection(taskSnapshot.ref, "comments"));
    const batch = api.writeBatch(db);
    comments.docs.forEach((comment) => batch.delete(comment.ref));
    batch.delete(taskSnapshot.ref);
    await batch.commit();
  }
  const batch = api.writeBatch(db);
  members.docs.filter((member) => member.data().userUid !== ownerUid).forEach((member) => batch.delete(member.ref));
  activities.docs.forEach((activity) => batch.delete(activity.ref));
  batch.delete(boardRef);
  await batch.commit();
}

export async function listMembers(boardId, api, db, includeInvites = true) {
  const boardRef = api.doc(db, BOARD_COLLECTION, boardId);
  const members = await api.getDocs(api.collection(boardRef, MEMBER_COLLECTION));
  const invites = includeInvites
    ? await api.getDocs(api.query(api.collection(db, INVITE_COLLECTION), api.where("boardId", "==", boardId)))
    : { docs: [] };
  return {
    members: members.docs.map((snapshot) => ({ id: snapshot.id, ...snapshot.data() })),
    invites: invites.docs.filter((snapshot) => snapshot.data().status === "pending").map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }))
  };
}

export async function inviteMember(boardId, email, role, api, db, user) {
  const normalizedEmail = email.trim().toLowerCase();
  const boardRef = api.doc(db, BOARD_COLLECTION, boardId);
  const [members, invites] = await Promise.all([
    api.getDocs(api.collection(boardRef, MEMBER_COLLECTION)),
    api.getDocs(api.query(api.collection(db, INVITE_COLLECTION), api.where("boardId", "==", boardId)))
  ]);
  if (members.docs.some((member) => String(member.data().email || "").toLowerCase() === normalizedEmail)
    || invites.docs.some((invite) => invite.data().email === normalizedEmail && invite.data().status === "pending")) {
    throw { code: "invite/already-member" };
  }
  const inviteRef = api.doc(api.collection(db, INVITE_COLLECTION));
  await api.setDoc(inviteRef, {
    boardId,
    email: normalizedEmail,
    role,
    createdBy: user.uid,
    status: "pending",
    createdAt: api.serverTimestamp()
  });
}

export async function changeMemberRole(boardId, memberUid, role, api, db) {
  await api.updateDoc(api.doc(db, BOARD_COLLECTION, boardId, MEMBER_COLLECTION, memberUid), { role });
}

export async function removeMember(boardId, memberUid, api, db) {
  await api.deleteDoc(api.doc(db, BOARD_COLLECTION, boardId, MEMBER_COLLECTION, memberUid));
}

export function subscribeBoard(api, db, boardId, role, userUid, onUpdate, onError) {
  const boardRef = api.doc(db, BOARD_COLLECTION, boardId);
  let boardSnapshot = null;
  let taskSnapshots = null;
  let currentRole = role;
  const publish = () => {
    if (boardSnapshot && taskSnapshots && boardSnapshot.exists()) {
      onUpdate(assembleBoard(boardSnapshot, taskSnapshots.docs, currentRole));
    }
  };
  const stopBoard = api.onSnapshot(boardRef, (snapshot) => { boardSnapshot = snapshot; publish(); }, onError);
  const stopTasks = api.onSnapshot(api.collection(boardRef, TASK_COLLECTION), (snapshot) => { taskSnapshots = snapshot; publish(); }, onError);
  const stopMember = api.onSnapshot(api.doc(boardRef, MEMBER_COLLECTION, userUid), (snapshot) => {
    if (!snapshot.exists()) {
      if (currentRole !== "OWNER") onError({ code: "permission-denied" });
      return;
    }
    if (snapshot.data().role !== currentRole) {
      currentRole = snapshot.data().role;
      publish();
    }
  }, onError);
  return () => { stopBoard(); stopTasks(); stopMember(); };
}

export function subscribeComments(api, db, boardId, taskId, onUpdate, onError) {
  const comments = api.query(
    api.collection(db, BOARD_COLLECTION, boardId, TASK_COLLECTION, taskId, "comments"),
    api.orderBy("createdAt", "asc")
  );
  return api.onSnapshot(comments, (snapshot) => onUpdate(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))), onError);
}

export async function addComment(boardId, taskId, text, api, db, user) {
  const commentRef = api.doc(api.collection(db, BOARD_COLLECTION, boardId, TASK_COLLECTION, taskId, "comments"));
  await api.setDoc(commentRef, {
    authorUid: user.uid,
    authorName: user.displayName || user.email || "Usuário",
    text: text.trim(),
    createdAt: api.serverTimestamp()
  });
}

export function createLocalBoardId(api) {
  return api.doc(api.collection(api.getFirestore(), "_ids")).id;
}