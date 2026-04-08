export function setupKanbanRoutes(app, io, getDb, getWaClientWrapper) {
  // --- Kanban API Routes ---
  app.post('/api/kanban/chats/:id/messages', async (req, res) => {
    const db = getDb(req.user);
    const waWrapper = getWaClientWrapper(req.user);
    if (!db || !waWrapper || waWrapper.status !== 'connected') {
      return res.status(500).json({ error: 'Database error or WhatsApp not connected' });
    }
    
    const { body } = req.body;
    const chatId = req.params.id;
    
    try {
      const sentMsg = await waWrapper.client.sendMessage(chatId, body);
      const msgId = sentMsg.id.id;
      const timestamp = Date.now();
      
      db.run("INSERT INTO kanban_messages (id, chat_id, body, from_me, timestamp) VALUES (?, ?, ?, ?, ?)",
        [msgId, chatId, body || '', 1, timestamp]);
        
      db.run("UPDATE kanban_chats SET last_message = ?, last_message_time = ? WHERE id = ?",
        [body || 'Media', timestamp, chatId]);
        
      io.emit('new_message', {
        id: msgId,
        chat_id: chatId,
        body: body || '',
        from_me: 1,
        timestamp
      });
      
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  app.get('/api/kanban/columns', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    db.all("SELECT * FROM kanban_columns ORDER BY position ASC", (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  });

  app.post('/api/kanban/columns', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    const { id, name, position, color } = req.body;
    db.run("INSERT INTO kanban_columns (id, name, position, color) VALUES (?, ?, ?, ?)", [id, name, position, color || '#e2e8f0'], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('columns_updated');
      res.json({ success: true });
    });
  });

  app.put('/api/kanban/columns/:id', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    const { name, position, color } = req.body;
    db.run("UPDATE kanban_columns SET name = ?, position = ?, color = ? WHERE id = ?", [name, position, color || '#e2e8f0', req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('columns_updated');
      res.json({ success: true });
    });
  });

  app.delete('/api/kanban/columns/:id', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    const colId = req.params.id;
    db.get("SELECT id FROM kanban_columns WHERE id != ? ORDER BY position ASC LIMIT 1", [colId], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      const targetColId = row ? row.id : null;
      if (targetColId) {
        db.run("UPDATE kanban_chats SET column_id = ? WHERE column_id = ?", [targetColId, colId], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          db.run("DELETE FROM kanban_columns WHERE id = ?", [colId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('columns_updated');
            io.emit('chat_updated');
            res.json({ success: true });
          });
        });
      } else {
        res.status(400).json({ error: 'Cannot delete the last column' });
      }
    });
  });

  app.get('/api/kanban/chats', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    db.all(`
      SELECT c.*, GROUP_CONCAT(t.id) as tag_ids
      FROM kanban_chats c
      LEFT JOIN kanban_chat_tags ct ON c.id = ct.chat_id
      LEFT JOIN kanban_tags t ON ct.tag_id = t.id
      GROUP BY c.id
      ORDER BY c.last_message_time DESC
    `, (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const formattedRows = rows.map((r) => ({
        ...r,
        tag_ids: r.tag_ids ? r.tag_ids.split(',') : []
      }));
      res.json(formattedRows);
    });
  });

  app.put('/api/kanban/chats/:id/column', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    const { column_id } = req.body;
    db.run("UPDATE kanban_chats SET column_id = ? WHERE id = ?", [column_id, req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('chat_updated', { id: req.params.id, column_id });
      res.json({ success: true });
    });
  });

  app.put('/api/kanban/chats/:id/name', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    const { name } = req.body;
    db.run("UPDATE kanban_chats SET name = ? WHERE id = ?", [name, req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('chat_updated', { id: req.params.id, name });
      res.json({ success: true });
    });
  });

  app.put('/api/kanban/chats/:id/read', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    db.run("UPDATE kanban_chats SET unread_count = 0 WHERE id = ?", [req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('chat_updated', { id: req.params.id, unread_count: 0 });
      res.json({ success: true });
    });
  });

  app.get('/api/kanban/tags', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    db.all("SELECT * FROM kanban_tags", (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  });

  app.post('/api/kanban/tags', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    const { id, name, color } = req.body;
    db.run("INSERT INTO kanban_tags (id, name, color) VALUES (?, ?, ?)", [id, name, color], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('tags_updated');
      res.json({ success: true });
    });
  });

  app.put('/api/kanban/tags/:id', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    const { name, color } = req.body;
    db.run("UPDATE kanban_tags SET name = ?, color = ? WHERE id = ?", [name, color, req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('tags_updated');
      res.json({ success: true });
    });
  });

  app.delete('/api/kanban/tags/:id', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    db.serialize(() => {
      db.run("DELETE FROM kanban_chat_tags WHERE tag_id = ?", [req.params.id]);
      db.run("DELETE FROM kanban_tags WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('tags_updated');
        res.json({ success: true });
      });
    });
  });

  app.post('/api/kanban/chats/:id/tags', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    const { tag_id } = req.body;
    db.run("INSERT INTO kanban_chat_tags (chat_id, tag_id) VALUES (?, ?)", [req.params.id, tag_id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('chat_tags_updated', { chat_id: req.params.id });
      res.json({ success: true });
    });
  });

  app.delete('/api/kanban/chats/:id/tags/:tag_id', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    db.run("DELETE FROM kanban_chat_tags WHERE chat_id = ? AND tag_id = ?", [req.params.id, req.params.tag_id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('chat_tags_updated', { chat_id: req.params.id });
      res.json({ success: true });
    });
  });

  app.get('/api/kanban/chats/:id/messages', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    db.all("SELECT * FROM kanban_messages WHERE chat_id = ? ORDER BY timestamp ASC", [req.params.id], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  });

  app.delete('/api/kanban/chats/:id', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    const chatId = req.params.id;
    db.run("DELETE FROM kanban_messages WHERE chat_id = ?", [chatId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.run("DELETE FROM kanban_chat_tags WHERE chat_id = ?", [chatId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run("DELETE FROM kanban_chats WHERE id = ?", [chatId], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          io.emit('chat_deleted', { id: chatId });
          res.json({ success: true });
        });
      });
    });
  });
}
