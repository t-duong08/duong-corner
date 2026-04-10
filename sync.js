const fs = require('fs');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1mLTaEXsMT3oOodS0wjvYpsfqOWPtsP4eiKBH2h8aeh8/export?format=csv';

async function fetchUrl(url, redirectCount = 0) {
  if (redirectCount > 5) throw new Error('Too many redirects');
  
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
    };

    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let nextUrl = res.headers.location;
        if (!nextUrl.startsWith('http')) {
            const currentUrl = new URL(url);
            nextUrl = new URL(nextUrl, currentUrl.origin).href;
        }
        return fetchUrl(nextUrl, redirectCount + 1).then(resolve).catch(reject);
      }
      
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to fetch ${url}, status: ${res.statusCode}`));
      }

      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function getShopeeImage(shopeeUrl) {
  try {
    console.log(`  Attempting to get image for: ${shopeeUrl}`);
    
    // Support for both /product/SHOP/ITEM and PRODUCT-i.SHOP.ITEM formats
    let match = shopeeUrl.match(/product\/(\d+)\/(\d+)/);
    if (!match) {
        match = shopeeUrl.match(/i\.(\d+)\.(\d+)/);
    }
    
    if (match) {
      const [_, shopId, itemId] = match;
      const apiUrl = `https://shopee.vn/api/v4/item/get?itemid=${itemId}&shopid=${shopId}`;
      try {
          const apiResponse = await fetchUrl(apiUrl);
          const json = JSON.parse(apiResponse);
          const imageHash = json.item?.image || json.item?.images?.[0] || json.data?.image || json.data?.images?.[0];
          if (imageHash) {
            return `https://down-vn.img.susercontent.com/file/${imageHash}`;
          }
      } catch (e) {
          console.warn(`  API fetch failed for ${shopeeUrl}, falling back to HTML scraping...`);
      }
    }
    
    // Fallback: Scraping HTML
    const html = await fetchUrl(shopeeUrl);
    
    // Try to find image hash in scripts first (more reliable sometimes)
    const scriptMatch = html.match(/"image":"([a-f0-9]{32})"/);
    if (scriptMatch) return `https://down-vn.img.susercontent.com/file/${scriptMatch[1]}`;

    // og:image
    const ogMatch = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || 
                    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
    if (ogMatch) return ogMatch[1];
    
    return null;
  } catch (e) {
    console.error(`  Error fetching Shopee image: ${e.message}`);
    return null;
  }
}

function parseCSV(csvText) {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) return [];

  const parseLine = (line) => {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (line[i] === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += line[i];
      }
    }
    fields.push(current);
    return fields;
  };

  const header = parseLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = parseLine(line);
    const obj = {};
    header.forEach((h, i) => {
      if (h) obj[h] = values[i]?.trim() || '';
    });
    return obj;
  });
}

async function sync() {
  console.log('--- START SYNC ---');
  console.log(`Fetching data from: ${SHEET_CSV_URL}`);
  
  let csv;
  try {
    csv = await fetchUrl(SHEET_CSV_URL);
  } catch (e) {
    console.error('CRITICAL: Failed to fetch Google Sheet CSV:', e.message);
    process.exit(1);
  }

  const rows = parseCSV(csv);
  console.log(`Found ${rows.length} rows in CSV.`);
  
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
    const shopeeUrl = row['Link gốc'];
    const productName = row['Tên sản phẩm'];
    
    if (!shopeeUrl || !productName) {
        if (shopeeUrl || productName) {
            console.warn(`Skipping incomplete row: ${productName || 'No Name'} (${shopeeUrl || 'No Link'})`);
        }
        continue;
    }
    
    console.log(`Processing: ${productName}`);
    const sheetImage = row['Link Ảnh'];
    const image = sheetImage || await getShopeeImage(shopeeUrl);
    
    const rawCat = row['Ngành hàng'] || 'Khác';
    const mappedCat = categoryMap[rawCat] || rawCat;
    
    products.push({
      id: row['STT'] || Math.random().toString(36).substr(2, 9),
      name: productName,
      category: mappedCat,
      brand: row['Ghi chú'] || 'Thuy Duong Picks',
      price: '', 
      image: image || 'https://via.placeholder.com/400?text=No+Image',
      link: shopeeUrl,
      review: row['Ghi chú'] || 'Sản phẩm cực xinh, chất lượng ổn áp lắm nha.',
      recommended: row['Trạng thái'] === 'Hoạt động'
    });
  }

  if (products.length === 0) {
    console.error('No products found to sync. Check CSV structure and content.');
    return;
  }

  const productsJson = JSON.stringify(products, null, 2);
  
  // 1. Update src/data.json (for Vite app)
  const dataJsonPath = path.resolve('./src/data.json');
  if (fs.existsSync(dataJsonPath)) {
    fs.writeFileSync(dataJsonPath, productsJson);
    console.log(`Successfully updated ${dataJsonPath} with ${products.length} products!`);
  }

  // 2. Update HTML files (for standalone version)
  const htmlFiles = ['./index.html', './preview.html'];

  for (const filePath of htmlFiles) {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      console.warn(`File ${filePath} not found, skipping...`);
      continue;
    }

    let html = fs.readFileSync(absolutePath, 'utf8');
    const startMarker = 'const productsData = [';
    const endMarker = '];';
    
    const startIndex = html.indexOf(startMarker);
    if (startIndex === -1) {
        console.error(`Could not find start marker "${startMarker}" in ${filePath}`);
        continue;
    }

    const endIndex = html.indexOf(endMarker, startIndex);
    if (endIndex === -1) {
        console.error(`Could not find end marker "${endMarker}" after productsData in ${filePath}`);
        continue;
    }
    
    const newData = `const productsData = ${productsJson};`;
    html = html.substring(0, startIndex) + newData + html.substring(endIndex + endMarker.length);
    fs.writeFileSync(absolutePath, html);
    console.log(`Successfully updated ${filePath} with ${products.length} products!`);
  }
  console.log('--- SYNC COMPLETE ---');
}

sync().catch(err => {
    console.error('Sync failed:', err);
    process.exit(1);
});

