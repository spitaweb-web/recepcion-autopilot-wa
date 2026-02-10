(async function(){
  async function load(){
    const a = await fetch("/api/admin/appointments").then(r=>r.json());
    const h = await fetch("/api/admin/handoffs").then(r=>r.json());

    const itemsA = (a.items || []);
    const itemsH = (h.items || []);

    document.getElementById("countA").textContent = itemsA.length + " total";
    document.getElementById("countH").textContent = itemsH.length + " total";

    const rowsA = document.getElementById("rowsA");
    rowsA.innerHTML = "";
    if(itemsA.length === 0){
      rowsA.innerHTML = '<tr><td colspan="10" style="padding:18px;color:var(--muted);">Sin turnos todavía. Volvé a <a style="text-decoration:underline" href="/">/</a> y probá la demo.</td></tr>';
    } else {
      itemsA.forEach(x => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td style="color:var(--muted)">${x.created_at}</td>
          <td class="mono" style="font-size:12px">${x.id}</td>
          <td>${x.user_phone}</td>
          <td>${x.service}</td>
          <td>${x.location}</td>
          <td>${x.coverage}</td>
          <td>$${x.deposit_amount}</td>
          <td>${x.start_at}</td>
          <td>${x.status}</td>
          <td>${x.payment_status}</td>
        `;
        rowsA.appendChild(tr);
      });
    }

    const rowsH = document.getElementById("rowsH");
    rowsH.innerHTML = "";
    if(itemsH.length === 0){
      rowsH.innerHTML = '<tr><td colspan="5" style="padding:18px;color:var(--muted);">Sin handoffs todavía. En el chat, respondé <span class="mono" style="color:rgba(230,237,243,.85)">4</span>.</td></tr>';
    } else {
      itemsH.forEach(x => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td style="color:var(--muted)">${x.created_at}</td>
          <td class="mono" style="font-size:12px">${x.id}</td>
          <td>${x.user_phone}</td>
          <td>${x.reason}</td>
          <td>${x.status}</td>
        `;
        rowsH.appendChild(tr);
      });
    }
  }

  load();
  setInterval(load, 1500);
})();
