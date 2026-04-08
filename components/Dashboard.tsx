
import React, { useState, useEffect, useRef } from 'react';
import { 
  Building2, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  Loader2,
  Send,
  Plus,
  Bot,
  User,
  MoreVertical
} from 'lucide-react';
import { Task, TaskStatus } from '../types';
import TaskModal from './TaskModal';
import { api } from '../services/api';

// Stats mais compactos para o topo
const CompactStatCard: React.FC<{ title: string; value: string | number; icon: any; color: string }> = ({ title, value, icon: Icon, color }) => (
  <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 flex items-center justify-between">
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{title}</p>
        <h3 className="text-xl font-bold text-gray-800 mt-1">{value}</h3>
      </div>
      <div className={`p-2 rounded-lg ${color} bg-opacity-10 text-opacity-100`}>
        <Icon className={`w-5 h-5 ${color.replace('bg-', 'text-')}`} />
      </div>
  </div>
);

const Dashboard: React.FC = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [recentSends, setRecentSends] = useState<any[]>([]);
  const [companiesCount, setCompaniesCount] = useState(0);
  const [loading, setLoading] = useState(true);
  
  // Modal states for Calendar interactions
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  // AI Chat states
  const [chatMessages, setChatMessages] = useState<{role: 'user' | 'ai', text: string}[]>([]);
  const [currentMessage, setCurrentMessage] = useState('');
  const [isAiTyping, setIsAiTyping] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const loadData = async () => {
    try {
      const [t, c, s] = await Promise.all([
        api.getTasks(),
        api.getCompanies(),
        api.getRecentSends()
      ]);
      setTasks(t);
      setCompaniesCount(c.length);
      setRecentSends(s);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, isAiTyping]);

  const handleTaskClick = (task: Task) => {
      setEditingTask(task);
      setIsTaskModalOpen(true);
  };

  const handleSaveTask = async (task: Task) => {
      try {
          await api.saveTask(task);
          setIsTaskModalOpen(false);
          loadData(); // Reload everything
      } catch (e) {
          alert("Erro ao salvar tarefa");
      }
  };

  const handleDeleteTask = async (taskId: number) => {
      try {
          await api.deleteTask(taskId);
          setIsTaskModalOpen(false);
          loadData();
      } catch (e) {
          alert("Erro ao excluir tarefa");
      }
  };

  const handleSendMessage = async () => {
    if (!currentMessage.trim()) return;
    
    const userMsg = currentMessage;
    setChatMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setCurrentMessage('');
    setIsAiTyping(true);

    try {
      const response = await api.sendChatMessage(userMsg);
      setChatMessages(prev => [...prev, { role: 'ai', text: response.reply }]);
    } catch (error) {
      console.error("Erro ao enviar mensagem para IA:", error);
      setChatMessages(prev => [...prev, { role: 'ai', text: "Desculpe, ocorreu um erro ao processar sua solicitação." }]);
    } finally {
      setIsAiTyping(false);
    }
  };

  const pendingTasks = tasks.filter(t => t.status !== TaskStatus.DONE).length;
  const urgentTasks = tasks.filter(t => t.priority === 'alta' && t.status !== TaskStatus.DONE);

  if (loading) return <div className="flex justify-center p-10"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;

  return (
    <div className="space-y-6 h-full flex flex-col">
      {/* 1. Visão Geral Compacta */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 flex-shrink-0">
        <CompactStatCard 
          title="Empresas" 
          value={companiesCount} 
          icon={Building2} 
          color="bg-blue-500" 
        />
        <CompactStatCard 
          title="Pendências" 
          value={pendingTasks} 
          icon={Clock} 
          color="bg-yellow-500" 
        />
        <CompactStatCard 
          title="Urgentes" 
          value={urgentTasks.length} 
          icon={AlertCircle} 
          color="bg-red-500" 
        />
        <CompactStatCard 
          title="Envios (Hoje)" 
          value={recentSends.length} // Simplificação para demo
          icon={CheckCircle2} 
          color="bg-green-500" 
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1 min-h-0">
        {/* 2. Copiloto IA */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 flex flex-col h-[500px] lg:h-auto">
          <div className="p-4 border-b border-gray-200 bg-gray-50 rounded-t-xl flex items-center gap-2">
            <Bot className="w-5 h-5 text-blue-600" />
            <h2 className="font-semibold text-gray-800">Copiloto IA</h2>
          </div>
          
          <div className="flex-1 p-4 overflow-y-auto space-y-4">
            {chatMessages.length === 0 && (
              <div className="text-center text-gray-500 mt-10">
                <Bot className="w-12 h-12 mx-auto text-gray-300 mb-3" />
                <p>Olá! Sou seu assistente operacional.</p>
                <p className="text-sm">Como posso ajudar com o atendimento hoje?</p>
              </div>
            )}
            {chatMessages.map((msg, idx) => (
              <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-lg p-3 ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-br-none' : 'bg-gray-100 text-gray-800 rounded-bl-none'}`}>
                  <p className="text-sm whitespace-pre-wrap">{msg.text}</p>
                </div>
              </div>
            ))}
            {isAiTyping && (
              <div className="flex justify-start">
                <div className="bg-gray-100 text-gray-800 rounded-lg rounded-bl-none p-3 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Processando...</span>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="p-4 border-t border-gray-200">
            <div className="flex gap-2">
              <input
                type="text"
                value={currentMessage}
                onChange={(e) => setCurrentMessage(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                placeholder="Pergunte sobre mensagens, clientes, resumos..."
                className="flex-1 border border-gray-300 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={handleSendMessage}
                disabled={isAiTyping || !currentMessage.trim()}
                className="bg-blue-600 text-white p-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                <Send className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>

        {/* 3. Lista de Tarefas */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 flex flex-col h-[500px] lg:h-auto">
          <div className="p-4 border-b border-gray-200 bg-gray-50 rounded-t-xl flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
              <h2 className="font-semibold text-gray-800">Tarefas</h2>
            </div>
            <button
              onClick={() => {
                setEditingTask(null);
                setIsTaskModalOpen(true);
              }}
              className="flex items-center gap-1 text-sm bg-blue-600 text-white px-3 py-1.5 rounded-md hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Nova Tarefa
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-2">
            {tasks.length === 0 ? (
              <div className="text-center text-gray-500 mt-10">
                <p>Nenhuma tarefa cadastrada.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {tasks.map(task => (
                  <div 
                    key={task.id} 
                    onClick={() => handleTaskClick(task)}
                    className="p-3 border border-gray-100 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors flex items-start justify-between group"
                  >
                    <div>
                      <h4 className={`font-medium ${task.status === TaskStatus.DONE ? 'line-through text-gray-400' : 'text-gray-800'}`}>
                        {task.title}
                      </h4>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <span className={`text-xs px-2 py-1 rounded-full font-medium
                        ${task.priority === 'alta' ? 'bg-red-100 text-red-700' : 
                          task.priority === 'media' ? 'bg-yellow-100 text-yellow-700' : 
                          'bg-blue-100 text-blue-700'}`}
                      >
                        {task.priority}
                      </span>
                      <span className={`text-xs px-2 py-1 rounded-full font-medium
                        ${task.status === TaskStatus.PENDING ? 'bg-gray-100 text-gray-700' : 
                          task.status === TaskStatus.IN_PROGRESS ? 'bg-blue-100 text-blue-700' : 
                          'bg-green-100 text-green-700'}`}
                      >
                        {task.status === TaskStatus.PENDING ? 'A Fazer' : 
                         task.status === TaskStatus.IN_PROGRESS ? 'Em Andamento' : 'Concluído'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal para edição */}
      <TaskModal 
        isOpen={isTaskModalOpen} 
        onClose={() => setIsTaskModalOpen(false)} 
        task={editingTask} 
        onSave={handleSaveTask}
        onDelete={handleDeleteTask}
      />
    </div>
  );
};

export default Dashboard;
