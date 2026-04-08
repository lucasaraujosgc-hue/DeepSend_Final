
import React, { useState, useEffect } from 'react';
import { 
  Building2, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { Task, TaskStatus } from '../types';
import Kanban from './Kanban';
import DashboardCalendar from './DashboardCalendar';
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

  const pendingTasks = tasks.filter(t => t.status !== TaskStatus.DONE).length;
  const urgentTasks = tasks.filter(t => t.priority === 'alta' && t.status !== TaskStatus.DONE);

  if (loading) return <div className="flex justify-center p-10"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;

  return (
    <div className="space-y-6">
      {/* 1. Visão Geral Compacta */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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

      {/* 2. Calendário Mensal em Destaque */}
      <div>
          <DashboardCalendar tasks={tasks} onTaskClick={handleTaskClick} />
      </div>

      {/* 3. Gerenciador de Tarefas (Kanban) */}
      <div className="pt-4 border-t border-gray-200">
          <Kanban />
      </div>

      {/* Modal para edição via Calendário */}
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
