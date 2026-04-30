import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.static(path.resolve(__dirname, '../public')));

const STOCK_LIST_URL = 'https://finance.naver.com/sise/sise_market_sum.naver?sosok=0&page=';

async function fetchKospiTopMarketCap(pages = 2) {
  const stocks = [];

  for (let page = 1; page <= pages; page += 1) {
    const { data } = await axios.get(`${STOCK_LIST_URL}${page}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const $ = cheerio.load(data);
    $('a.tltle').each((_, el) => {
      const name = $(el).text().trim();
      const href = $(el).attr('href') || '';
      const codeMatch = href.match(/code=(\d+)/);
      if (name && codeMatch?.[1]) {
        stocks.push({
          name,
          code: codeMatch[1]
        });
      }
    });
  }

  const uniqueMap = new Map();
  stocks.forEach((s) => uniqueMap.set(s.code, s));
  return Array.from(uniqueMap.values());
}

async function fetchWeeklyChange(code) {
  const url = `https://finance.naver.com/item/sise_day.naver?code=${code}`;
  const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(data);

  const closePrices = [];
  $('table.type2 tr').each((_, row) => {
    const tds = $(row).find('td');
    const date = $(tds[0]).text().trim();
    const close = $(tds[1]).text().replace(/,/g, '').trim();
    if (date && /^\d{4}\.\d{2}\.\d{2}$/.test(date) && close) {
      closePrices.push(Number(close));
    }
  });

  if (closePrices.length < 2) return null;

  const latest = closePrices[0];
  const oneWeekAgo = closePrices[Math.min(4, closePrices.length - 1)];
  const changePct = ((latest - oneWeekAgo) / oneWeekAgo) * 100;

  return {
    latest,
    oneWeekAgo,
    weeklyChangePct: Number(changePct.toFixed(2))
  };
}

function parseNumber(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, '').replace(/[^\d.-]/g, '').trim();
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

async function fetchQuarterlyFinancials(code) {
  const url = `https://finance.naver.com/item/main.naver?code=${code}`;
  const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(data);

  const table = $('div.section.cop_analysis table').first();
  const quarterLabels = [];
  table.find('thead tr').eq(1).find('th').each((_, th) => {
    const txt = $(th).text().trim();
    if (txt) quarterLabels.push(txt);
  });

  const salesRow = table.find('tbody tr').filter((_, tr) => $(tr).find('th').text().includes('매출액')).first();
  const opRow = table.find('tbody tr').filter((_, tr) => $(tr).find('th').text().includes('영업이익')).first();

  const sales = [];
  salesRow.find('td').each((i, td) => {
    const value = parseNumber($(td).text());
    if (value !== null && quarterLabels[i]) sales.push({ quarter: quarterLabels[i], value });
  });

  const operatingProfit = [];
  opRow.find('td').each((i, td) => {
    const value = parseNumber($(td).text());
    if (value !== null && quarterLabels[i]) operatingProfit.push({ quarter: quarterLabels[i], value });
  });

  const recentSales = sales.slice(-5);
  const recentOp = operatingProfit.slice(-5);

  if (recentOp.length < 2) {
    return { recentSales, recentOperatingProfit: recentOp, opGrowthPct: null };
  }

  const first = recentOp[0].value;
  const last = recentOp[recentOp.length - 1].value;
  const opGrowthPct = first === 0 ? null : Number((((last - first) / Math.abs(first)) * 100).toFixed(2));

  return {
    recentSales,
    recentOperatingProfit: recentOp,
    opGrowthPct
  };
}

app.get('/api/stocks/analyze', async (_req, res) => {
  try {
    const baseList = await fetchKospiTopMarketCap(2);
    const targets = baseList.slice(0, 20);

    const analyzed = await Promise.all(targets.map(async (stock) => {
      try {
        const weekly = await fetchWeeklyChange(stock.code);
        const financials = await fetchQuarterlyFinancials(stock.code);
        return {
          ...stock,
          ...weekly,
          ...financials
        };
      } catch (err) {
        return null;
      }
    }));

    const valid = analyzed.filter(Boolean);

    const byWeekly = [...valid]
      .filter((s) => typeof s.weeklyChangePct === 'number')
      .sort((a, b) => b.weeklyChangePct - a.weeklyChangePct)
      .slice(0, 10);

    const byOpGrowth = [...valid]
      .filter((s) => typeof s.opGrowthPct === 'number')
      .sort((a, b) => b.opGrowthPct - a.opGrowthPct)
      .slice(0, 10);

    res.json({
      generatedAt: new Date().toISOString(),
      scannedCount: targets.length,
      byWeekly,
      byOpGrowth
    });
  } catch (error) {
    res.status(500).json({ message: '데이터 분석 중 오류가 발생했습니다.', detail: error.message });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
