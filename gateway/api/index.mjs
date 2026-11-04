// Adaptador de Vercel: todo el tráfico entra por acá (ver vercel.json) y lo enruta src/app.mjs.
import { handle } from '../src/app.mjs';

export default handle;
