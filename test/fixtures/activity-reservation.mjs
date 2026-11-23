import { reserveActivityRequest } from '../../dist/activity/control.js';
try { await reserveActivityRequest('image'); process.stdout.write('reserved'); }
catch { process.stdout.write('blocked'); }
