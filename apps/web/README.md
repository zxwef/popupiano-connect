# PopuConnect Web

Статическая заготовка на HTML, CSS и TypeScript. В ней есть виртуальная клавиатура на одну октаву со звуком через Web Audio. Аккорды, гаммы и управление физической PopuPiano через Web MIDI запланированы на следующий этап. Показания батареи зависят от подтверждения протокола.

## Запуск

Из этой папки на Node.js 22.12+ в PowerShell выполните:

```powershell
npm.cmd ci
npm.cmd run dev
```

## Сборка для GitHub Pages

```powershell
npm.cmd run build
npm.cmd run preview
```

Публикуемый каталог — `dist/`. Сборка использует относительные URL для размещения в подпапке GitHub Pages. В GitHub Actions собирайте проект из `apps/web` и передавайте `apps/web/dist` как Pages artifact. [Руководство Vite по GitHub Pages](https://vite.dev/guide/static-deploy.html#github-pages)
