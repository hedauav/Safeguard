import { NavLink, Link } from 'react-router-dom'
import { FileText, Phone, BarChart3, Settings, Headphones, Database, Shield, Scale } from 'lucide-react'

const navItems = [
  { to: '/claims', icon: FileText, label: 'Claims' },
  { to: '/review', icon: Scale, label: 'Review Queue' },
  { to: '/calls', icon: Phone, label: 'Call History' },
  { to: '/live', icon: Headphones, label: 'Live Call' },
  { to: '/analytics', icon: BarChart3, label: 'Analytics' },
  { to: '/blockchain', icon: Database, label: 'Evidence' },
  { to: '/config', icon: Settings, label: 'Agent Config' },
]

export function Sidebar() {
  return (
    <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
      <Link to="/">
        <div className="p-6 border-b border-gray-200 cursor-pointer hover:opacity-80 transition-opacity">
          <div className="flex items-center gap-2">
            <Shield className="w-6 h-6 text-blue-600" />
            <span className="text-xl font-bold text-gray-900">SafeGuard</span>
          </div>
          <p className="text-sm text-gray-500 mt-1">Insurance AI Agent</p>
        </div>
      </Link>
      <nav className="flex-1 p-4 space-y-1">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              }`
            }
          >
            <Icon className="w-5 h-5" />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
