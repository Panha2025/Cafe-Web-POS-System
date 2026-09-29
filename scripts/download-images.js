import { mkdir, writeFile } from 'node:fs/promises';
const photos = {
  americano: 'photo-1514432324607-a09d9b4aefdd',
  cappuccino: 'photo-1534778101976-62847782c213',
  latte: 'photo-1570968915860-54d5c301fa9f',
  mocha: 'photo-1461023058943-07fcbe16d735',
  matcha: 'photo-1515823064-d6e0c04616a7',
  'thai-tea': 'photo-1556679343-c7306c1976bc',
  chocolate: 'photo-1572490122747-3968b75cc699',
  'lemon-tea': 'photo-1556679343-c7306c1976bc',
  'peach-soda': 'photo-1544145945-f90425340c7e',
  'strawberry-soda': 'photo-1544145945-f90425340c7e',
  croissant: 'photo-1555507036-ab1f4038808a',
  muffin: 'photo-1607958996333-41aef7caefaa',
  cheesecake: 'photo-1533134242443-d4fd215305ad',
  'chocolate-cake': 'photo-1578985545062-69928b1d9587',
  cookies: 'photo-1499636136210-6f4ee915583e',
};
await mkdir('frontend/public/images', { recursive: true });
const sources = [];
for (const [name, id] of Object.entries(photos)) {
  const url = `https://images.unsplash.com/${id}?auto=format&fit=crop&w=500&h=440&q=85`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await writeFile(
      `frontend/public/images/${name}.jpg`,
      Buffer.from(await response.arrayBuffer()),
    );
    sources.push(`${name}.jpg: ${url}`);
    console.log(`Saved ${name}.jpg`);
  } catch (e) {
    console.error(`${name}: ${e.message}`);
  }
}
await writeFile(
  'frontend/public/images/SOURCES.txt',
  'Demo menu photography downloaded from Unsplash. Replace with your own product photos through Products. Images are illustrative.\n\n' +
    sources.join('\n'),
);
