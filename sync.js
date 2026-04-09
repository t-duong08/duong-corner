import fs from 'fs';
import https from 'https';
import path from 'path';

const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1mLTaEXsMT3oOodS0wjvYpsfqOWPtsP4eiKBH2h8aeh8/export?format=csv';
const INDEX_PATH = './index.html';

async function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
    };
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function getShopeeImage(shopeeUrl) {
  try {
    const match = shopeeUrl.match(/product\/(\d+)\/(\d+)/);
    if (!match) return null;
    const [_, shopId, itemId] = match;
    const apiUrl = `https://shopee.vn/api/v4/item/get?itemid=${itemId}&shopid=${shopId}`;
    const apiResponse = await fetchUrl(apiUrl);
    const json = JSON.parse(apiResponse);
    const imageHash = json.data?.image;
    if (imageHash) {
      return `https://down-vn.img.susercontent.com/file/${imageHash}`;
    }
    // Fallback to og:image from HTML
    const html = await fetchUrl(shopeeUrl);
    const ogMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
    return ogMatch ? ogMatch[1] : null;
  } catch (e) {
    console.error(`Error fetching Shopee image for ${shopeeUrl}:`, e.message);
    return null;
  }
}

function parseCSV(csvText) {
  const lines = csvText.split('\n').filter(line => line.trim());
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    const obj = {};
    header.forEach((h, i) => obj[h.trim()] = values[i]?.trim());
    return obj;
  });
}

async function sync() {
  console.log('Fetching Google Sheet data...');
  const csv = await fetchUrl(SHEET_CSV_URL);
  const rows = parseCSV(csv);
  
  // Read current index.html to keep existing manually set images/reviews if needed
  // OR just build from scratch from CSV. 
  // For now, let's build productsData from the Sheet rows.
  
  const categoryMap = {
    'Thời trang': 'Clothing',
    'Thời trang trẻ em': 'Baby products',
    'Phụ kiện': 'Accessories',
    'Giày dép': 'Shoes',
    'Làm đẹp': 'Beauty',
    'Đồ gia dụng': 'Home appliances'
  };

  const products = [];
  for (const row of rows) {
    if (!row['Link gốc']) continue;
    
    console.log(`Processing: ${row['Tên sản phẩm']}...`);
    const shopeeUrl = row['Link gốc'];
    const image = await getShopeeImage(shopeeUrl);
    
    const rawCat = row['Ngành hàng'];
    const mappedCat = categoryMap[rawCat] || rawCat;
    
    products.push({
      id: row['STT'] || Math.random().toString(36).substr(2, 9),
      name: row['Tên sản phẩm'],
      category: mappedCat,
      brand: row['Ghi chú'] || '',
      price: '', 
      image: image || 'https://via.placeholder.com/400?text=No+Image',
      link: shopeeUrl,
      review: row['Ghi chú'] || 'Sản phẩm cực xinh, chất lượng ổn áp lắm nha.',
      recommended: row['Trạng thái'] === 'Hoạt động'
    });
  }

  const productsJson = JSON.stringify(products, null, 2);
  let indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');
  
  const startMarker = 'const productsData = [';
  const endMarker = '];';
  
  const startIndex = indexHtml.indexOf(startMarker);
  const endIndex = indexHtml.indexOf(endMarker, startIndex);
  
  if (startIndex !== -1 && endIndex !== -1) {
    const newData = `const productsData = ${productsJson};`;
    indexHtml = indexHtml.substring(0, startIndex) + newData + indexHtml.substring(endIndex + endMarker.length);
    fs.writeFileSync(INDEX_PATH, indexHtml);
    console.log('Successfully updated index.html with new products!');
  } else {
    console.error('Could not find productsData array in index.html');
  }
}

sync();
