export async function publishCatalogSnapshot(db) {
  const snapshot = (
    await db.query(`
      SELECT jsonb_build_object(
        'settings', (SELECT jsonb_build_object(
          'cafe_name',s.cafe_name,'address',s.address,'phone',s.phone,
          'currency',s.currency,'tax_percentage',s.tax_percentage,'logo_url',s.logo_url
        ) FROM settings s WHERE s.id = 1),
        'categories', COALESCE(
          (SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) ORDER BY c.id) FROM categories c),
          '[]'::jsonb
        ),
        'products', COALESCE(
          (SELECT jsonb_agg(jsonb_build_object(
             'id',p.id,'name',p.name,'price',p.price,'category_id',p.category_id,
             'available',p.available,'image_url',p.image_url,'updated_at',p.updated_at,
             'deleted_at',p.deleted_at,'category',c.name
           ) ORDER BY p.id)
           FROM products p JOIN categories c ON c.id = p.category_id),
          '[]'::jsonb
        )
      ) AS snapshot
    `)
  ).rows[0].snapshot;

  const state = (await db.query('SELECT version FROM catalog_state WHERE id = 1 FOR UPDATE'))
    .rows[0];
  if (!state) throw new Error('Catalog version state is missing. Run database migrations first.');

  const latest = (
    await db.query('SELECT version, snapshot FROM catalog_snapshots ORDER BY version DESC LIMIT 1')
  ).rows[0];
  if (latest) {
    const same = (
      await db.query('SELECT $1::jsonb = $2::jsonb AS same', [
        JSON.stringify(snapshot),
        latest.snapshot,
      ])
    ).rows[0].same;
    if (same) return latest.version;
  }

  const version = (
    await db.query(
      'UPDATE catalog_state SET version = version + 1, updated_at = now() WHERE id = 1 RETURNING version',
    )
  ).rows[0].version;
  await db.query('INSERT INTO catalog_snapshots(version, snapshot) VALUES ($1, $2)', [
    version,
    JSON.stringify(snapshot),
  ]);
  return version;
}
