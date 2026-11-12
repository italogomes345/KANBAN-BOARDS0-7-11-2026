# Quadros Kanban com Firebase

Aplicação estática em HTML, CSS e JavaScript. Não precisa de Node.js nem npm. O Firebase Authentication gerencia o login e o Cloud Firestore guarda um documento de boards por usuário.

## Arquivos

- `index.html`, `style.css`, `script.js`: interface e lógica da aplicação.
- `firebase-config.js`: configuração do seu app Web Firebase; preenchido localmente e ignorado pelo Git.
- `firebase-config.example.js`: modelo de configuração sem valores reais.
- `firestore.rules`: regras para revisar e publicar no Firestore.

## 1. Criar e configurar o projeto Firebase

1. Acesse [console.firebase.google.com](https://console.firebase.google.com/) com sua conta Google e crie seu próprio projeto.
2. Na visão geral do projeto, adicione um app Web pelo ícone `</>` e registre o app.
3. Copie os valores de `firebaseConfig` fornecidos para esse app. O `firebase-config` identifica o projeto; não é senha nem chave privada. Não use credenciais de usuário nesse arquivo.
4. No VS Code, copie `firebase-config.example.js` para `firebase-config.js` e preencha `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId` e `appId` com os valores do seu console.
5. Em **Authentication > Método de login**, habilite **E-mail/senha**.
6. Em **Firestore Database**, crie o banco. Escolha com cuidado a localização: ela não poderá ser alterada depois.
7. Abra **Firestore Database > Regras**, substitua o conteúdo pelas regras de `firestore.rules` e publique. Nunca deixe regras de teste nem `allow read, write: if true`.
8. Não crie coleção ou documento manualmente. Depois da primeira autenticação e das regras estarem publicadas, o app cria `boards/{uid}` automaticamente.

## 2. Executar no computador

1. Instale a extensão **Live Server** do VS Code, se ainda não estiver instalada.
2. Abra `index.html` e selecione **Open with Live Server**.
3. O endereço local deve ser HTTP em `localhost` (por exemplo, `http://127.0.0.1:5500`). Não abra o arquivo com `file://`: os módulos ES e o Firebase precisam de um servidor local.
4. Cadastre uma conta de teste com e-mail, nome de usuário (usado como nome de exibição) e senha de pelo menos 8 caracteres.
5. O Firebase Authentication exige e-mail para entrar. O campo de login aceita e-mail; o nome de usuário é o nome exibido no cabeçalho.
6. Se o navegador já tiver dados locais antigos, escolha no diálogo importar um perfil ou começar sem importação. Os dados antigos só são removidos depois que o documento inicial é confirmado no Firestore. Senhas, hashes, salts e sessões antigas nunca são importados.

## 3. Estrutura dos dados

O modelo atual separa os dados por quadro:

- `boards/{boardId}`: metadados, colunas, backlog, sprints e Definition of Done.
- `boards/{boardId}/members/{uid}`: papel `OWNER`, `EDITOR` ou `VIEWER` e identidade do membro.
- `boards/{boardId}/tasks/{taskId}`: tarefa, responsável, prazo, prioridade, labels, checklist, critérios de aceite e story points.
- `boards/{boardId}/tasks/{taskId}/comments/{commentId}`: texto, autor e timestamp.
- `boardInvites/{inviteId}`: convites pendentes por e-mail; a conta resgata o convite ao entrar com o mesmo endereço.
- `userMigrations/{uid}`: marcador para que a migração do formato antigo ocorra uma só vez.

No primeiro login após a atualização, o app migra `boards/{uid}` (schema 1) para quadros individuais (schema 2), preservando o documento antigo como cópia. A importação local já existente continua disponível quando não há dados Firestore anteriores.

## 4. Regras de segurança

As regras em `firestore.rules` verificam associação e papel no servidor: membros podem ler; `OWNER` e `EDITOR` podem editar tarefas e comentar; apenas `OWNER` pode administrar membros, alterar nome/cor ou excluir o quadro. A interface também oculta/desabilita ações de leitura, mas a segurança não depende dela. A exclusão do último registro de membro não concede acesso: as regras consultam o UID autenticado em cada operação.

O `firebaseConfig` de um app Web não é segredo: ele é entregue ao navegador. A proteção dos dados vem das regras do Firestore e da validação de identidade pelo Firebase Authentication, não de esconder a configuração. Não coloque senhas, tokens privados ou credenciais de usuário no config. Regras não podem ficar abertas ou em modo de teste.

### Testar as regras no simulador

1. Abra **Firestore Database > Regras > Simulador de regras**.
2. Sem autenticação, tente ler `/boards/{boardId}`: deve ser negada.
3. Como membro, leia o quadro e as tarefas: deve ser permitido.
4. Como `VIEWER`, tente criar/alterar uma tarefa ou comentário: deve ser negado.
5. Como `EDITOR`, tente editar uma tarefa: deve ser permitido; tente renomear o quadro ou alterar membros: deve ser negado.
6. Como `OWNER`, convide um e-mail, altere o papel e remova o membro: deve ser permitido.

## 5. Publicar e demonstrar

O Hosting possui rewrite para `/tasks/**`, necessário para abrir links profundos diretamente. Publique o Hosting e as regras juntos:

```powershell
firebase deploy --project boards-kanban
```

Depois, confirme que o domínio `boards-kanban.web.app` está em **Authentication > Configurações > Domínios autorizados**.

### Demo de 2 minutos com duas contas

1. Na conta A, crie um quadro, abra **Membros**, convide o e-mail da conta B como `VIEWER` e copie o link da tarefa para compartilhar por um canal externo.
2. Entre na conta B em outro perfil do navegador, aceite o convite ao entrar e abra o quadro em **Compartilhados comigo**.
3. Na conta B, tente criar uma tarefa: os controles de edição devem estar ausentes; uma tentativa direta de escrita no Firestore deve ser negada pelas regras.
4. Abra o link `/tasks/{id}` em nova aba enquanto B está autenticada. Confira leitura dos campos e comentários existentes.
5. Na conta A, altere B para `EDITOR`. Atualize B, edite uma tarefa e publique um comentário; confira a atualização no quadro e o autor/data do comentário.
6. Na conta A, remova B. Atualize a tela B e confirme que o quadro deixa de estar acessível.

## 6. Limitações conhecidas

- O Firebase Authentication gerencia credenciais e sessão; o app não grava UID, e-mail, senha ou token em `localStorage`.
- O tema claro/escuro continua salvo em `localStorage`; não contém dados de conta.
- Tentativas repetidas são limitadas pelo próprio Firebase. O app traduz `auth/too-many-requests`, mas não implementa rate limit no servidor.
- O projeto não implementa verificação de e-mail, App Check, Cloud Functions ou envio automático de e-mail. Convites ficam pendentes no Firestore e são resgatados no login; o envio da notificação deve ser feito por fora.
- WIP é validado no fluxo de interface; a autorização de leitura/escrita é sempre validada pelas regras Firestore.
- O histórico de atividades e notificações não foi incluído; são recursos bônus, fora dos critérios mínimos implementados.
- Um site estático não consegue manter `firebase-config.js` privado no navegador; isso não é uma fronteira de segurança do Firebase.
