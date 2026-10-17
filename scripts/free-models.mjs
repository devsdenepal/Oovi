import 'dotenv/config';

const res = await fetch('https://openrouter.ai/api/v1/models', {
  headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
});
const { data } = await res.json();
const free = (data || []).filter(
  (m) => Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0,
);
console.log(`free models: ${free.length}`);
for (const m of free) {
  const params = m.supported_parameters || [];
  const structured = params.includes('structured_outputs') || params.includes('response_format');
  console.log(`${m.id} | ctx=${m.context_length} | structured=${structured}`);
}
