import React, { useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';
import { QrCode, Smartphone, RefreshCw, Plus, MessageCircle, Settings, Tag as TagIcon, Menu, X, Edit2, XCircle, HardDrive, Image as ImageIcon, Download, Trash2, Play, Pause, Check } from 'lucide-react';
import { format } from 'date-fns';

const socket = io('/', { transports: ['websocket', 'polling'] });

export interface Column {
  id: string;
  name: string;
  position: number;
  color?: string;
}

export interface Chat {
  id: string;
  name: string;
  phone: string;
  column_id: string;
  last_message: string;
  last_message_time: number;
  unread_count: number;
  profile_pic?: string;
  tag_ids: string[];
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface Message {
  id: string;
  chat_id: string;
  body: string;
  from_me: number;
  timestamp: number;
  media_url?: string;
  media_type?: string;
  media_name?: string;
  transcription?: string;
}

function AudioPlayer({ src }: { src: string }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = React.useRef<HTMLAudioElement>(null);

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setProgress((audioRef.current.currentTime / audioRef.current.duration) * 100);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (audioRef.current) {
      const newTime = (Number(e.target.value) / 100) * audioRef.current.duration;
      audioRef.current.currentTime = newTime;
      setProgress(Number(e.target.value));
    }
  };

  const formatTime = (time: number) => {
    if (isNaN(time)) return "0:00";
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex items-center gap-2 bg-black/5 rounded-full p-2 min-w-[200px] w-full max-w-[300px]">
      <button 
        onClick={togglePlay} 
        className="w-8 h-8 flex items-center justify-center bg-blue-500 text-white rounded-full hover:bg-blue-600 flex-shrink-0"
      >
        {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-1" />}
      </button>
      <div className="flex-1 flex flex-col justify-center">
        <input 
          type="range" 
          min="0" 
          max="100" 
          value={progress || 0} 
          onChange={handleSeek}
          className="w-full h-1 bg-gray-300 rounded-lg appearance-none cursor-pointer accent-blue-500"
        />
        <div className="flex justify-between text-[10px] text-gray-500 mt-1 px-1">
          <span>{formatTime(audioRef.current?.currentTime || 0)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
      <audio 
        ref={audioRef} 
        src={src} 
        onTimeUpdate={handleTimeUpdate} 
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={() => { setIsPlaying(false); setProgress(0); }}
        className="hidden"
      />
    </div>
  );
}

export default function WhatsKanban() {
  const [columns, setColumns] = useState<Column[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [uploadingMedia, setUploadingMedia] = useState(false);

  const [isAddingColumn, setIsAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState('');
  const [newColumnColor, setNewColumnColor] = useState('#e2e8f0');
  
  const [searchQuery, setSearchQuery] = useState('');
  
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null);
  const [editColumnName, setEditColumnName] = useState('');
  const [editColumnColor, setEditColumnColor] = useState('#e2e8f0');

  const [isAddingTag, setIsAddingTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#3b82f6');
  
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState('');
  const [editTagColor, setEditTagColor] = useState('#3b82f6');

  const [chatToTag, setChatToTag] = useState<string | null>(null);

  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(true);
  const [selectedTagFilters, setSelectedTagFilters] = useState<string[]>([]);
  const [editingChatNameId, setEditingChatNameId] = useState<string | null>(null);
  const [editChatName, setEditChatName] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, selectedChat]);

  const apiFetch = async (url: string, options: RequestInit = {}) => {
    const token = localStorage.getItem('cm_auth_token');
    const headers = new Headers(options.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      throw new Error('Unauthorized');
    }
    return res;
  };

  useEffect(() => {
    fetchData();

    socket.on('columns_updated', fetchData);
    socket.on('tags_updated', fetchData);
    socket.on('chat_updated', fetchData);
    socket.on('new_chat', fetchData);
    socket.on('chat_deleted', (data: { id: string }) => {
      if (selectedChat?.id === data.id) {
        setSelectedChat(null);
      }
      fetchData();
    });
    socket.on('chat_tags_updated', fetchData);

    socket.on('new_message', (msg: Message) => {
      if (selectedChat && msg.chat_id === selectedChat.id) {
        setMessages(prev => [...prev, msg]);
      }
      fetchData(); // Refresh chats list for last_message
    });

    return () => {
      socket.off('columns_updated');
      socket.off('tags_updated');
      socket.off('chat_updated');
      socket.off('new_chat');
      socket.off('chat_tags_updated');
      socket.off('new_message');
    };
  }, [selectedChat]);

  const fetchData = async () => {
    try {
      const [colsRes, chatsRes, tagsRes] = await Promise.all([
        apiFetch('/api/kanban/columns'),
        apiFetch('/api/kanban/chats'),
        apiFetch('/api/kanban/tags')
      ]);
      
      setColumns(await colsRes.json());
      setChats(await chatsRes.json());
      setTags(await tagsRes.json());
    } catch (error) {
      console.error('Error fetching data:', error);
    }
  };

  const loadMessages = async (chatId: string) => {
    try {
      const res = await apiFetch(`/api/kanban/chats/${chatId}/messages`);
      setMessages(await res.json());
    } catch (error) {
      console.error('Error loading messages:', error);
    }
  };

  const handleChatSelect = async (chat: Chat) => {
    setSelectedChat(chat);
    setIsRightSidebarOpen(true);
    if (chat.unread_count > 0) {
      try {
        await apiFetch(`/api/kanban/chats/${chat.id}/read`, { method: 'PUT' });
        setChats(prev => prev.map(c => c.id === chat.id ? { ...c, unread_count: 0 } : c));
      } catch (error) {
        console.error('Error marking chat as read:', error);
      }
    }
    loadMessages(chat.id);
  };

  const handleDeleteChat = async (chatId: string) => {
    if (window.confirm('Tem certeza que deseja excluir esta conversa? Todos os dados serão perdidos.')) {
      try {
        await apiFetch(`/api/kanban/chats/${chatId}`, { method: 'DELETE' });
        if (selectedChat?.id === chatId) {
          setSelectedChat(null);
        }
        fetchData();
      } catch (error) {
        console.error('Error deleting chat:', error);
      }
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedChat) return;

    try {
      await apiFetch(`/api/kanban/chats/${selectedChat.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: newMessage })
      });
      setNewMessage('');
    } catch (error) {
      console.error('Error sending message:', error);
    }
  };

  const handleAddColumn = async () => {
    if (!newColumnName.trim()) return;
    try {
      await apiFetch('/api/kanban/columns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'col-' + Date.now(),
          name: newColumnName,
          position: columns.length,
          color: newColumnColor
        })
      });
      setNewColumnName('');
      setNewColumnColor('#e2e8f0');
      setIsAddingColumn(false);
    } catch (error) {
      console.error('Error adding column:', error);
    }
  };

  const handleMoveChat = async (chatId: string, columnId: string) => {
    try {
      await apiFetch(`/api/kanban/chats/${chatId}/column`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column_id: columnId })
      });
    } catch (error) {
      console.error('Error moving chat:', error);
    }
  };

  const handleEditColumn = async (columnId: string) => {
    if (!editColumnName.trim()) return;
    try {
      const column = columns.find(c => c.id === columnId);
      if (!column) return;
      await apiFetch(`/api/kanban/columns/${columnId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editColumnName,
          position: column.position,
          color: editColumnColor
        })
      });
      setEditingColumnId(null);
    } catch (error) {
      console.error('Error editing column:', error);
    }
  };

  const handleDeleteColumn = async (columnId: string) => {
    if (columns.length <= 1) {
      alert('Não é possível excluir a última coluna.');
      return;
    }
    if (confirm('Tem certeza que deseja excluir esta coluna? Os chats serão movidos para outra coluna.')) {
      try {
        await apiFetch(`/api/kanban/columns/${columnId}`, { method: 'DELETE' });
        setEditingColumnId(null);
      } catch (error) {
        console.error('Error deleting column:', error);
      }
    }
  };

  const handleAddTag = async () => {
    if (!newTagName.trim()) return;
    try {
      await apiFetch('/api/kanban/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'tag-' + Date.now(),
          name: newTagName,
          color: newTagColor
        })
      });
      setNewTagName('');
      setIsAddingTag(false);
    } catch (error) {
      console.error('Error adding tag:', error);
    }
  };

  const handleEditTag = async (id: string) => {
    if (!editTagName.trim()) return;
    try {
      await apiFetch(`/api/kanban/tags/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editTagName,
          color: editTagColor
        })
      });
      setEditingTagId(null);
    } catch (error) {
      console.error('Error updating tag:', error);
    }
  };

  const handleDeleteTag = async (id: string) => {
    if (window.confirm('Tem certeza que deseja excluir esta tag? Ela será removida de todos os contatos.')) {
      try {
        await apiFetch(`/api/kanban/tags/${id}`, {
          method: 'DELETE'
        });
        setEditingTagId(null);
      } catch (error) {
        console.error('Error deleting tag:', error);
      }
    }
  };

  const handleAssignTag = async (chatId: string, tagId: string) => {
    try {
      await apiFetch(`/api/kanban/chats/${chatId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_id: tagId })
      });
      setChatToTag(null);
    } catch (error) {
      console.error('Error assigning tag:', error);
    }
  };

  const handleRemoveTag = async (chatId: string, tagId: string) => {
    try {
      await apiFetch(`/api/kanban/chats/${chatId}/tags/${tagId}`, {
        method: 'DELETE'
      });
    } catch (error) {
      console.error('Error removing tag:', error);
    }
  };

  const handleEditChatName = async (chatId: string) => {
    if (!editChatName.trim()) return;
    try {
      await apiFetch(`/api/kanban/chats/${chatId}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editChatName })
      });
      setEditingChatNameId(null);
    } catch (error) {
      console.error('Error editing chat name:', error);
    }
  };

  const handleDragStart = (e: React.DragEvent, chatId: string) => {
    e.dataTransfer.setData('chatId', chatId);
  };

  const handleColumnDrop = (e: React.DragEvent, columnId: string) => {
    e.preventDefault();
    const chatId = e.dataTransfer.getData('chatId');
    if (chatId) {
      handleMoveChat(chatId, columnId);
    }
  };

  const handleColumnDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const filteredChats = chats.filter(c => {
    const matchesTags = selectedTagFilters.length === 0 || selectedTagFilters.some(t => c.tag_ids.includes(t));
    const matchesSearch = searchQuery === '' || 
      (c.name && c.name.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (c.phone && c.phone.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (c.last_message && c.last_message.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesTags && matchesSearch;
  });

  return (
    <div className="flex h-full bg-gray-100 font-sans overflow-hidden rounded-xl border border-gray-200">
      {/* Kanban Board */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-4 border-b border-gray-200 bg-white flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="font-bold text-xl text-gray-800 flex items-center gap-2">
              <MessageCircle className="text-green-500" />
              WhatsKanban
            </h1>
            <input
              type="text"
              placeholder="Buscar chats..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-64 border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {tags.map(tag => {
              const isSelected = selectedTagFilters.includes(tag.id);
              const isEditing = editingTagId === tag.id;

              if (isEditing) {
                return (
                  <div key={tag.id} className="flex items-center gap-1 bg-white border border-blue-300 rounded-full px-2 py-1">
                    <input
                      type="text"
                      value={editTagName}
                      onChange={(e) => setEditTagName(e.target.value)}
                      className="w-20 text-xs outline-none bg-transparent"
                      autoFocus
                    />
                    <input 
                      type="color" 
                      value={editTagColor} 
                      onChange={(e) => setEditTagColor(e.target.value)}
                      className="w-4 h-4 p-0 border-0 rounded cursor-pointer"
                    />
                    <button onClick={() => handleEditTag(tag.id)} className="text-green-600 hover:text-green-700"><Check size={12} /></button>
                    <button onClick={() => setEditingTagId(null)} className="text-gray-500 hover:text-gray-700"><X size={12} /></button>
                  </div>
                );
              }

              return (
                <div key={tag.id} className="group relative flex items-center">
                  <button
                    onClick={() => {
                      if (isSelected) {
                        setSelectedTagFilters(prev => prev.filter(id => id !== tag.id));
                      } else {
                        setSelectedTagFilters(prev => [...prev, tag.id]);
                      }
                    }}
                    className={`text-xs px-2 py-1 rounded-full border flex items-center gap-1 transition-colors ${isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
                  >
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }}></div>
                    {tag.name}
                  </button>
                  <div className="absolute -top-2 -right-2 hidden group-hover:flex items-center bg-white border border-gray-200 rounded shadow-sm z-10">
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingTagId(tag.id);
                        setEditTagName(tag.name);
                        setEditTagColor(tag.color);
                      }}
                      className="p-1 text-gray-500 hover:text-blue-600"
                      title="Editar Tag"
                    >
                      <Edit2 size={10} />
                    </button>
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteTag(tag.id);
                      }}
                      className="p-1 text-gray-500 hover:text-red-600"
                      title="Excluir Tag"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
              );
            })}
            <button 
              onClick={() => setIsAddingTag(true)}
              className="text-xs text-blue-600 flex items-center gap-1 hover:underline ml-2"
            >
              <Plus size={12} /> Nova Tag
            </button>
          </div>
        </div>

        {isAddingTag && (
          <div className="p-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
            <input
              type="text"
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              placeholder="Nome da tag"
              className="border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
              autoFocus
            />
            <input 
              type="color" 
              value={newTagColor} 
              onChange={(e) => setNewTagColor(e.target.value)}
              className="w-6 h-6 p-0 border-0 rounded cursor-pointer"
            />
            <button onClick={handleAddTag} className="bg-blue-600 text-white text-[10px] px-2 py-1 rounded hover:bg-blue-700">Salvar</button>
            <button onClick={() => setIsAddingTag(false)} className="bg-gray-200 text-gray-700 text-[10px] px-2 py-1 rounded hover:bg-gray-300">Cancelar</button>
          </div>
        )}

        <div className="flex-1 overflow-x-auto p-6 flex gap-6">
        {columns.map(column => (
          <div 
            key={column.id} 
            className="flex-shrink-0 w-80 bg-gray-50 rounded-xl border border-gray-200 flex flex-col max-h-full overflow-hidden shadow-sm"
            onDrop={(e) => handleColumnDrop(e, column.id)}
            onDragOver={handleColumnDragOver}
          >
            <div 
              className="p-3 border-b border-gray-200 flex justify-between items-center bg-gray-100 group"
              style={{ borderTop: `4px solid ${column.color || '#e2e8f0'}` }}
            >
              {editingColumnId === column.id ? (
                <div className="flex-1 flex flex-col gap-2">
                  <input
                    type="text"
                    value={editColumnName}
                    onChange={(e) => setEditColumnName(e.target.value)}
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-500"
                    autoFocus
                    onKeyDown={(e) => e.key === 'Enter' && handleEditColumn(column.id)}
                  />
                  <div className="flex items-center gap-2">
                    <input 
                      type="color" 
                      value={editColumnColor} 
                      onChange={(e) => setEditColumnColor(e.target.value)}
                      className="w-6 h-6 rounded cursor-pointer border-0 p-0"
                    />
                    <button onClick={() => handleEditColumn(column.id)} className="text-blue-600 text-xs font-medium bg-blue-50 px-2 py-1 rounded">Salvar</button>
                    <button onClick={() => setEditingColumnId(null)} className="text-gray-500 text-xs font-medium bg-gray-100 px-2 py-1 rounded">Cancelar</button>
                    <button onClick={() => handleDeleteColumn(column.id)} className="text-red-600 text-xs font-medium bg-red-50 px-2 py-1 rounded ml-auto" title="Excluir Coluna">
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                <h3 
                  className="font-semibold text-gray-700 flex-1 cursor-pointer hover:text-blue-600 flex items-center gap-2"
                  onClick={() => {
                    setEditingColumnId(column.id);
                    setEditColumnName(column.name);
                    setEditColumnColor(column.color || '#e2e8f0');
                  }}
                  title="Clique para editar"
                >
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: column.color || '#e2e8f0' }}></span>
                  {column.name}
                </h3>
              )}
              <span className="bg-gray-200 text-gray-600 text-xs px-2 py-1 rounded-full font-medium ml-2">
                {filteredChats.filter(c => c.column_id === column.id).length}
              </span>
            </div>
            
            <div className="p-3 flex-1 overflow-y-auto space-y-3">
              {filteredChats.filter(c => c.column_id === column.id).map(chat => (
                <div 
                  key={chat.id} 
                  onClick={() => handleChatSelect(chat)}
                  draggable
                  onDragStart={(e) => handleDragStart(e, chat.id)}
                  className={`group bg-white p-3 rounded-lg shadow-sm border cursor-pointer hover:shadow-md transition-shadow ${selectedChat?.id === chat.id ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200'}`}
                >
                  <div className="flex justify-between items-start mb-1">
                    <div className="flex items-center gap-2 overflow-hidden">
                      {chat.profile_pic ? (
                        <img 
                          src={chat.profile_pic} 
                          alt="" 
                          className="w-8 h-8 rounded-full object-cover flex-shrink-0" 
                          referrerPolicy="no-referrer"
                        />
                      ) : null}
                      <div className={`w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 flex-shrink-0 ${chat.profile_pic ? 'hidden' : ''}`}>
                        {chat.name ? chat.name.charAt(0).toUpperCase() : '?'}
                      </div>
                      {editingChatNameId === chat.id ? (
                        <input
                          type="text"
                          value={editChatName}
                          onChange={(e) => setEditChatName(e.target.value)}
                          onBlur={() => handleEditChatName(chat.id)}
                          onKeyDown={(e) => e.key === 'Enter' && handleEditChatName(chat.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="font-medium text-gray-900 border-b border-blue-500 focus:outline-none w-full"
                          autoFocus
                        />
                      ) : (
                        <h4 className="font-medium text-gray-900 truncate pr-2 flex items-center gap-1 group/name">
                          {chat.name || chat.phone}
                          <button 
                            onClick={(e) => { e.stopPropagation(); setEditingChatNameId(chat.id); setEditChatName(chat.name || chat.phone); }}
                            className="opacity-0 group-hover/name:opacity-100 text-gray-400 hover:text-blue-500 transition-opacity"
                          >
                            <Edit2 size={12} />
                          </button>
                        </h4>
                      )}
                    </div>
                    {chat.unread_count > 0 && (
                      <span className="bg-green-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0">
                        {chat.unread_count}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 truncate mb-2">{chat.last_message}</p>
                  
                  <div className="flex justify-between items-center mt-2">
                    <div className="flex flex-wrap gap-1">
                      {chat.tag_ids.map(tagId => {
                        const tag = tags.find(t => t.id === tagId);
                        if (!tag) return null;
                        return (
                          <div key={tagId} className="flex items-center gap-1 bg-gray-100 px-1.5 py-0.5 rounded text-[10px] text-gray-600 group/tag">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }} />
                            <span>{tag.name}</span>
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleRemoveTag(chat.id, tagId); }}
                              className="opacity-0 group-hover/tag:opacity-100 text-gray-400 hover:text-red-500 ml-0.5"
                            >
                              <X size={10} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                      <span className="text-[10px] text-gray-400">
                        {chat.last_message_time ? format(new Date(chat.last_message_time), 'HH:mm') : ''}
                      </span>
                      <button 
                        onClick={(e) => { e.stopPropagation(); handleDeleteChat(chat.id); }}
                        className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-opacity"
                        title="Excluir conversa"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Add Column Button */}
        <div className="flex-shrink-0 w-80">
          {isAddingColumn ? (
            <div className="bg-white p-3 rounded-xl border border-gray-200 shadow-sm">
              <input
                type="text"
                value={newColumnName}
                onChange={(e) => setNewColumnName(e.target.value)}
                placeholder="Nome da coluna"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm mb-2 focus:outline-none focus:border-blue-500"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleAddColumn()}
              />
              <div className="flex items-center gap-2 mb-2">
                <label className="text-xs text-gray-500">Cor:</label>
                <input 
                  type="color" 
                  value={newColumnColor} 
                  onChange={(e) => setNewColumnColor(e.target.value)}
                  className="w-6 h-6 rounded cursor-pointer border-0 p-0"
                />
              </div>
              <div className="flex gap-2">
                <button onClick={handleAddColumn} className="bg-blue-600 text-white text-xs px-3 py-1.5 rounded hover:bg-blue-700">Salvar</button>
                <button onClick={() => setIsAddingColumn(false)} className="bg-gray-100 text-gray-600 text-xs px-3 py-1.5 rounded hover:bg-gray-200">Cancelar</button>
              </div>
            </div>
          ) : (
            <button 
              onClick={() => setIsAddingColumn(true)}
              className="w-full flex items-center justify-center gap-2 bg-gray-50 border-2 border-dashed border-gray-300 text-gray-500 rounded-xl py-4 hover:bg-gray-100 hover:text-gray-700 transition-colors"
            >
              <Plus size={20} /> Adicionar Coluna
            </button>
          )}
        </div>
      </div>
    </div>

    {/* Chat Panel */}
      {selectedChat && isRightSidebarOpen && (
        <div className="w-96 bg-white border-l border-gray-200 flex flex-col shadow-xl z-10">
          <div className="p-4 border-b border-gray-200 flex flex-col bg-gray-50">
            <div className="flex justify-between items-start mb-2">
              <div className="flex items-center gap-3">
                {selectedChat.profile_pic ? (
                  <img 
                    src={selectedChat.profile_pic} 
                    alt="" 
                    className="w-10 h-10 rounded-full object-cover flex-shrink-0" 
                  />
                ) : null}
                <div className={`w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 flex-shrink-0 ${selectedChat.profile_pic ? 'hidden' : ''}`}>
                  {selectedChat.name ? selectedChat.name.charAt(0).toUpperCase() : '?'}
                </div>
                <div>
                  <h3 className="font-bold text-gray-800">{selectedChat.name || selectedChat.phone}</h3>
                  <p className="text-xs text-gray-500">{selectedChat.phone}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button 
                  onClick={() => handleDeleteChat(selectedChat.id)} 
                  className="text-red-400 hover:text-red-600 p-1 rounded-md hover:bg-red-50 transition-colors" 
                  title="Excluir conversa"
                >
                  <Trash2 size={20} />
                </button>
                <button onClick={() => setSelectedChat(null)} className="text-gray-400 hover:text-gray-600 p-1 rounded-md hover:bg-gray-100 transition-colors" title="Fechar chat">
                  <X size={20} />
                </button>
              </div>
            </div>
            
            <div className="flex flex-wrap gap-1 items-center">
              {selectedChat.tag_ids.map(tagId => {
                const tag = tags.find(t => t.id === tagId);
                if (!tag) return null;
                return (
                  <span key={tagId} className="text-[10px] px-2 py-0.5 rounded-full text-white flex items-center gap-1" style={{ backgroundColor: tag.color }}>
                    {tag.name}
                  </span>
                );
              })}
              
              <div className="relative">
                <button 
                  onClick={() => setChatToTag(chatToTag === selectedChat.id ? null : selectedChat.id)}
                  className="text-[10px] bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full hover:bg-gray-300 flex items-center gap-1"
                >
                  <Plus size={10} /> Add Tag
                </button>
                
                {chatToTag === selectedChat.id && (
                  <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 shadow-lg rounded-md p-2 w-48 z-20">
                    <h4 className="text-xs font-semibold text-gray-500 mb-2">Selecione uma Tag</h4>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {tags.filter(t => !selectedChat.tag_ids.includes(t.id)).map(tag => (
                        <button
                          key={tag.id}
                          onClick={() => handleAssignTag(selectedChat.id, tag.id)}
                          className="w-full text-left text-xs px-2 py-1 hover:bg-gray-100 rounded flex items-center gap-2"
                        >
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }}></div>
                          {tag.name}
                        </button>
                      ))}
                      {tags.filter(t => !selectedChat.tag_ids.includes(t.id)).length === 0 && (
                        <p className="text-xs text-gray-400 italic">Nenhuma tag disponível</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#e5ddd5]">
            {messages.map(msg => (
              <div key={msg.id} className={`flex ${msg.from_me ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-lg p-2 text-sm shadow-sm ${msg.from_me ? 'bg-[#dcf8c6] text-gray-800' : 'bg-white text-gray-800'}`}>
                  {msg.media_url && (
                    <div className="mb-2">
                      {msg.media_type?.startsWith('image/') ? (
                        <img src={msg.media_url} alt="Media" className="max-w-full rounded-md max-h-64 object-contain" />
                      ) : (msg.media_type?.startsWith('audio/') || msg.media_type?.includes('ogg')) ? (
                        <div className="flex flex-col gap-2">
                          <AudioPlayer src={msg.media_url} />
                          {msg.transcription && (
                            <div className="bg-white/50 p-2 rounded text-xs italic border border-gray-200">
                              <span className="font-semibold not-italic text-gray-600 block mb-1">Transcrição:</span>
                              {msg.transcription}
                            </div>
                          )}
                        </div>
                      ) : msg.media_type?.startsWith('video/') ? (
                        <video controls src={msg.media_url} className="max-w-full rounded-md max-h-64" />
                      ) : (
                        <a href={msg.media_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 bg-black/5 p-2 rounded hover:bg-black/10 transition-colors">
                          <span className="text-2xl">📄</span>
                          <span className="truncate max-w-[200px]">{msg.media_name || 'Documento'}</span>
                        </a>
                      )}
                    </div>
                  )}
                  {msg.body && <p className="whitespace-pre-wrap">{msg.body}</p>}
                  <span className="text-[10px] text-gray-500 block text-right mt-1">
                    {format(new Date(msg.timestamp), 'HH:mm')}
                  </span>
                </div>
              </div>
            ))}
            {uploadingMedia && (
              <div className="flex justify-end">
                <div className="bg-[#dcf8c6] text-gray-800 max-w-[80%] rounded-lg p-2 text-sm shadow-sm italic opacity-70">
                  Enviando arquivo...
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
          
          <div className="p-3 border-t border-gray-200 bg-gray-50 relative">
            {uploadingMedia && (
              <div className="absolute inset-0 bg-white/50 flex items-center justify-center z-10">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-green-500"></div>
              </div>
            )}
            <form onSubmit={handleSendMessage} className="flex gap-2 items-center">
              <input
                type="text"
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder="Digite uma mensagem..."
                className="flex-1 border border-gray-300 rounded-full px-4 py-2 text-sm focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500"
                disabled={uploadingMedia}
              />
              <button 
                type="submit"
                disabled={!newMessage.trim() && !uploadingMedia}
                className="bg-green-500 text-white rounded-full w-10 h-10 flex items-center justify-center hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M1.101 21.757L23.8 12.028 1.101 2.3l.011 7.912 13.623 1.816-13.623 1.817-.011 7.912z"></path></svg>
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
