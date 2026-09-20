// Automated browser-workflow fixture, not product UI. Real HTTP forms/downloads; no provider mocks.
export const salesCsv = "item,quantity,price\nkeyboard,2,19.95\ncable,3,7.50\nstand,1,32.00\n";
export function browserSite() {
  const products = [
    { id: "budget", name: "Budget headphones", price: 19, stock: false },
    { id: "trail", name: "Trail headphones", price: 49, stock: true },
    { id: "studio", name: "Studio headphones", price: 79, stock: true },
  ];
  const uploads: { project: string; category: string; files: { name: string; text: string }[] }[] =
    [];
  const reservations: Record<string, string>[] = [];
  const rejections: string[] = [];
  const html = (body: string) =>
    new Response(
      `<!doctype html><title>Browser workflow lab</title><body><h1>Local test site</h1>${body}</body>`,
      { headers: { "Content-Type": "text/html" } },
    );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/upload" && request.method === "GET")
        return html(`
      <h2>Import project files</h2><p>Choose a project, category and files. Use Import to submit.</p>
      <form id="import-form" method="post" enctype="multipart/form-data" action="/import">
      <label>Project <input name="project" required></label>
      <label>Category <select name="category"><option>General</option><option>Research</option></select></label>
      <label>Attachments <input name="files" type="file" multiple required></label>
      <button>Import</button></form><p id="outcome" aria-live="polite"></p>
      <script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();document.querySelector('#outcome').textContent='Importing…';const r=await fetch('/import',{method:'POST',body:new FormData(e.target)});const b=await r.json();document.querySelector('#outcome').textContent=b.message;};</script>`);
      if (url.pathname === "/import" && request.method === "POST") {
        const form = await request.formData();
        const project = String(form.get("project") ?? ""),
          category = String(form.get("category") ?? "");
        const files = await Promise.all(
          form
            .getAll("files")
            .filter((f): f is File => f instanceof File)
            .map(async (f) => ({ name: f.name, text: await f.text() })),
        );
        if (project === "recovery" && files.some((f) => !f.name.endsWith(".csv"))) {
          rejections.push(project);
          return Response.json(
            {
              message:
                "Rejected: this project accepts CSV files only. Choose a .csv file and import again.",
            },
            { status: 422 },
          );
        }
        uploads.push({ project, category, files });
        await Bun.sleep(150);
        return Response.json({
          message: `Import successful. Receipt IMPORT-${uploads.length}. Project ${project}; category ${category}; files: ${files.map((f) => f.name).join(", ")}; ${files.reduce((n, f) => n + f.text.length, 0)} characters received.`,
        });
      }
      if (url.pathname === "/downloads")
        return html(
          '<h2>Sales data</h2><a href="/sales.csv">Download sales CSV</a><p>After processing it, use <a href="/upload">Import project files</a>.</p>',
        );
      if (url.pathname === "/sales.csv")
        return new Response(salesCsv, {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": 'attachment; filename="sales.csv"',
          },
        });
      if (url.pathname === "/catalog") {
        const query = url.searchParams.get("q") ?? "";
        return html(
          `<h2>Demo equipment reservation</h2><p>No purchases or real reservations are made.</p><form><label>Search products <input name="q"></label><button>Search</button></form>${
            query
              ? products
                  .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
                  .map(
                    (p) =>
                      `<p><a target="_blank" href="/product/${p.id}">${p.name}</a>: $${p.price}, ${p.stock ? "in stock" : "out of stock"}</p>`,
                  )
                  .join("")
              : "<p>Search to see matching products.</p>"
          }`,
        );
      }
      if (url.pathname.startsWith("/product/")) {
        const product = products.find((p) => p.id === url.pathname.split("/").at(-1));
        if (!product) return new Response("Unknown product", { status: 404 });
        return html(
          `<h2>${product.name}</h2><p>Price: $${product.price}. ${product.stock ? "In stock" : "Out of stock"}. Demo only.</p><form action="/reserve" method="post"><input type="hidden" name="product" value="${product.id}"><label>Name <input name="name" required></label><label>Color <select name="color"><option>Black</option><option>Blue</option></select></label><label>Quantity <input name="quantity" type="number" min="1" value="1"></label><label><input name="newsletter" type="checkbox"> Subscribe to newsletter</label><button ${product.stock ? "" : "disabled"}>Reserve demo item</button></form>`,
        );
      }
      if (url.pathname === "/reserve" && request.method === "POST") {
        const fields = Object.fromEntries((await request.formData()).entries()) as Record<
          string,
          string
        >;
        const product = products.find((p) => p.id === fields.product);
        if (!product?.stock) return new Response("Unavailable", { status: 422 });
        reservations.push(fields);
        return html(
          `<h2>Reservation confirmed</h2><p>Reference DEMO-${reservations.length}; ${product.name}; color ${fields.color}; quantity ${fields.quantity}; total $${product.price * Number(fields.quantity)}.</p>`,
        );
      }
      return html(
        '<a href="/catalog">Catalog</a> <a href="/upload">Import</a> <a href="/downloads">Downloads</a>',
      );
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}`, uploads, reservations, rejections };
}
