# 🚀 Deploy no Render - Guia Rápido

## ⚠️ Problema Comum: Erro de Build

Se você receber o erro:
```
bash: -c: line 1: unexpected EOF while looking for matching ``'
```

Isso geralmente acontece quando há problemas com aspas no comando de build.

## ✅ Solução

### Opção 1: Configurar via Dashboard do Render (Recomendado)

1. Acesse o dashboard do Render: https://dashboard.render.com
2. Vá em seu serviço (Web Service)
3. Em **Settings** > **Build Command**, configure:
   ```
   npm install && npm run build
   ```
4. Em **Settings** > **Start Command**, configure:
   ```
   npm start
   ```

### Opção 2: Usar render.yaml (Atualizado)

O arquivo `render.yaml` já está corrigido. Certifique-se de que está assim:

```yaml
services:
  - type: web
    name: task-organizer-api
    env: node
    buildCommand: npm install && npm run build
    startCommand: npm start
    envVars:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: 3001
      - key: DATABASE_URL
        sync: false
      - key: JWT_SECRET
        sync: false
      - key: GGCHECKOUT_API_URL
        value: https://api.ggcheckout.com
      - key: GGCHECKOUT_API_KEY
        sync: false
      - key: GGCHECKOUT_PRODUCT_ID
        sync: false
      - key: GGCHECKOUT_WEBHOOK_SECRET
        sync: false
      - key: FRONTEND_URL
        sync: false
```

## 📋 Variáveis de Ambiente no Render

Configure estas variáveis no dashboard do Render:

### Obrigatórias:
1. `DATABASE_URL` - String de conexão do Neon
2. `JWT_SECRET` - Chave secreta JWT
3. `GGCHECKOUT_API_KEY` - API Key do GGCheckout
4. `GGCHECKOUT_PRODUCT_ID` - ID do produto
5. `GGCHECKOUT_WEBHOOK_SECRET` - Secret do webhook
6. `FRONTEND_URL` - URL do frontend (ex: https://seu-app.vercel.app)

### Opcionais (já configuradas):
- `NODE_ENV=production`
- `PORT=3001`
- `GGCHECKOUT_API_URL=https://api.ggcheckout.com`

## 🔧 Passos para Deploy

1. **Conecte o repositório** no Render
2. **Configure o Root Directory** como `backend`
3. **Configure as variáveis de ambiente** (veja acima)
4. **Deploy!**

## 🐛 Troubleshooting

### Build falha
- Verifique se o `buildCommand` está correto no dashboard
- Certifique-se de que não há backticks (`) no comando
- Use: `npm install && npm run build`

### Erro de dependências
- Certifique-se de que o `package.json` está na pasta `backend`
- Verifique se todas as dependências estão listadas

### Erro de TypeScript
- O build compila TypeScript para JavaScript
- Certifique-se de que não há erros de tipo: `npm run build` localmente primeiro

### Erro ao iniciar
- Verifique se o `startCommand` está como `npm start`
- Certifique-se de que o arquivo `dist/index.js` existe após o build

## 📝 Notas

- O Render automaticamente detecta Node.js
- O build cria a pasta `dist/` com o código compilado
- O `startCommand` executa `node dist/index.js`

