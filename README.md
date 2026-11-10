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

O documento `boards/{uid}` contém `ownerUid`, `schemaVersion`, `boards` e `updatedAt`. Cada board inclui colunas e tarefas. O identificador do documento corresponde ao UID do Firebase Authentication. As alterações do Kanban são sincronizadas pelo app.

A aplicação valida tipos, tamanho de títulos/descrições, quantidades e tamanho total antes de exibir ou enviar os dados. As regras impõem autenticação, ownership e o formato básico do documento. As regras do Firestore não fazem uma validação profunda de cada elemento arbitrário de arrays; por isso, dados recebidos também são validados no cliente. O documento único é adequado para um projeto pequeno, mas o Firestore limita documentos a 1 MiB.

## 4. Regras de segurança

O texto completo está em `firestore.rules` e pode ser copiado para a aba **Regras** do Firestore. Usuários não autenticados são negados. Um usuário só pode acessar o documento cujo ID é seu próprio UID. Campos adicionais são rejeitados, assim como tipos incorretos no nível superior e mais de 20 boards.

O `firebaseConfig` de um app Web não é segredo: ele é entregue ao navegador. A proteção dos dados vem das regras do Firestore e da validação de identidade pelo Firebase Authentication, não de esconder a configuração. Não coloque senhas, tokens privados ou credenciais de usuário no config. Regras não podem ficar abertas ou em modo de teste.

### Testar as regras no simulador

1. Abra **Firestore Database > Regras > Simulador de regras**.
2. Tente ler `/boards/uid-de-teste` sem autenticação: a operação deve ser negada.
3. Simule usuário autenticado com UID `usuario-a` e tente ler `/boards/usuario-b`: deve ser negada.
4. Simule usuário autenticado com UID `usuario-a` e leia `/boards/usuario-a`: deve ser permitida se o documento existir.
5. Teste escrita autenticada com `ownerUid` diferente do UID ou com `schemaVersion`/`boards` de tipo inválido: deve ser negada.

## 5. Publicar com HTTPS

### GitHub Pages

1. Envie `index.html`, `style.css`, `script.js`, `firestore.rules` e `README.md` para a raiz do repositório.
2. Como `firebase-config.js` está no `.gitignore`, o GitHub Pages não o receberá automaticamente. Para um site estático, o config do Firebase Web é público por definição; depois de conferir que contém somente a configuração do app (nunca senhas ou tokens privados), inclua esse arquivo no repositório para o Pages servi-lo.
3. No computador, preencha `firebase-config.js` com os valores do seu projeto. O arquivo ignorado pode ser incluído explicitamente com `git add -f firebase-config.js` quando decidir publicar o app estático.
4. No GitHub, abra **Settings > Pages**, selecione **Deploy from a branch**, escolha `main` e `/ (root)`, e salve.
5. Aguarde o endereço `https://<usuario>.github.io/<repositorio>/`. Confirme que abre com HTTPS.
6. No Firebase, abra **Authentication > Configurações > Domínios autorizados** e adicione o domínio do Pages (por exemplo, `<usuario>.github.io`). Sem isso, o login publicado pode falhar.
7. Abra a URL em outro computador e teste cadastro/login e boards. Firestore sincroniza dados autenticados; a preferência de tema continua local.

### Netlify ou Vercel

1. Importe o repositório ou envie a pasta estática pelo painel da plataforma; não configure comando de build nem instalação npm.
2. Garanta que `firebase-config.js` esteja disponível na raiz publicada, seguindo o mesmo cuidado: somente configuração pública do app Web.
3. Use o domínio HTTPS gerado pela plataforma e adicione esse domínio em **Authentication > Configurações > Domínios autorizados** no Firebase.
4. Teste a URL pública e o login em outro computador.

## 6. Limitações conhecidas

- O Firebase Authentication gerencia credenciais e sessão; o app não grava UID, e-mail, senha ou token em `localStorage`.
- O tema claro/escuro continua salvo em `localStorage`; não contém dados de conta.
- Tentativas repetidas são limitadas pelo próprio Firebase. O app traduz `auth/too-many-requests`, mas não implementa rate limit no servidor.
- O projeto não implementa verificação de e-mail nem App Check.
- Regras impedem acesso ao documento de outra pessoa, mas não evitam que o próprio usuário autenticado apague ou altere seus boards.
- Um site estático não consegue manter `firebase-config.js` privado no navegador; isso não é uma fronteira de segurança do Firebase.
