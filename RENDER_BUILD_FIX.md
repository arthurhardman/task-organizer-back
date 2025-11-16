# 🔧 Correção do Build no Render

## ⚠️ Problema

O build está falhando porque as `devDependencies` (tipos TypeScript) não estão sendo instaladas.

## ✅ Solução

### No Dashboard do Render, configure:

**Build Command:**
```
npm ci && npm run build
```

Ou se não funcionar:

```
NODE_ENV=development npm install && npm run build
```

**Explicação:**
- `npm ci` instala todas as dependências (incluindo devDependencies)
- Ou use `NODE_ENV=development npm install` para forçar instalação de devDependencies

### Alternativa: Mover tipos para dependencies

Se ainda não funcionar, podemos mover os `@types/*` para `dependencies` ao invés de `devDependencies`.

## 📋 Passos

1. Acesse: https://dashboard.render.com
2. Vá no serviço **task-organizer-api**
3. **Settings** > **Build & Deploy**
4. Em **Build Command**, configure:
   ```
   npm ci && npm run build
   ```
5. **Save Changes**
6. **Manual Deploy** > **Deploy latest commit**

## 🔍 Verificação

O build deve:
1. Instalar todas as dependências (incluindo tipos)
2. Compilar TypeScript para JavaScript
3. Criar a pasta `dist/` com os arquivos compilados

