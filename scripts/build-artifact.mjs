// Builds a single self-contained HTML (no external files) for sharing/embedding.
// Output: dist/survact.html
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const js = await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  write: false,
});

const css = readFileSync('src/shell.css', 'utf8');
const shell = readFileSync('src/shell.html', 'utf8');
const code = js.outputFiles[0].text.replaceAll('</script', '<\\/script');

// No <html>/<head>/<body>: the host may wrap it; browsers accept it standalone too.
const out = `<title>survact</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Alfa+Slab+One&family=Fredoka:wght@400;500;600&display=swap" />
<style>html{box-sizing:border-box}
${css}</style>
${shell}<script>${code}</script>
`;
mkdirSync('dist', { recursive: true });
writeFileSync('dist/survact.html', out);
console.log(`dist/survact.html ${(out.length / 1024).toFixed(1)} kB`);
