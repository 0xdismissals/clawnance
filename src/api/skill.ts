import { Router } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = Router();
const rootDir = join(__dirname, '../../');

router.get('/skill.json', (req, res) => {
    const data = readFileSync(join(rootDir, 'skill.json'), 'utf8');
    res.header('Content-Type', 'application/json').send(data);
});

router.get('/skill.md', (req, res) => {
    const data = readFileSync(join(rootDir, 'skill.md'), 'utf8');
    res.header('Content-Type', 'text/markdown').send(data);
});

router.get('/heartbeat.md', (req, res) => {
    const data = readFileSync(join(rootDir, 'heartbeat.md'), 'utf8');
    res.header('Content-Type', 'text/markdown').send(data);
});

router.get('/trading.md', (req, res) => {
    const data = readFileSync(join(rootDir, 'trading.md'), 'utf8');
    res.header('Content-Type', 'text/markdown').send(data);
});

export default router;
