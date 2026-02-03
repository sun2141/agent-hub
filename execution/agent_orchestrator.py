#!/usr/bin/env python3
"""
Agent Orchestrator
Manages task distribution and coordination between specialized sub-agents
"""

import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional
from dataclasses import dataclass, asdict
from enum import Enum


class TaskStatus(Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    BLOCKED = "blocked"


class AgentType(Enum):
    UI = "ui_agent"
    DB = "db_agent"
    API = "api_agent"
    TEST = "test_agent"
    DEPLOY = "deploy_agent"


@dataclass
class Task:
    """Represents a task to be executed by an agent"""
    task_id: str
    agent: str
    description: str
    priority: str = "medium"
    dependencies: List[str] = None
    details: Dict = None
    status: str = TaskStatus.PENDING.value
    created_at: str = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    error: Optional[Dict] = None

    def __post_init__(self):
        if self.dependencies is None:
            self.dependencies = []
        if self.details is None:
            self.details = {}
        if self.created_at is None:
            self.created_at = datetime.now().isoformat()


@dataclass
class TaskResult:
    """Represents the result of a completed task"""
    task_id: str
    status: str
    output: Dict = None
    error: Optional[Dict] = None
    completed_at: str = None

    def __post_init__(self):
        if self.output is None:
            self.output = {}
        if self.completed_at is None:
            self.completed_at = datetime.now().isoformat()


class AgentOrchestrator:
    """Orchestrates tasks across multiple specialized agents"""

    def __init__(self, workspace_root: str = "/Users/sun/20260128_test"):
        self.workspace_root = Path(workspace_root)
        self.tasks_dir = self.workspace_root / ".tmp" / "agent_tasks"
        self.tasks_dir.mkdir(parents=True, exist_ok=True)

        # Task tracking
        self.tasks: Dict[str, Task] = {}
        self.results: Dict[str, TaskResult] = {}
        self.task_counter = 0

    def generate_task_id(self, agent_type: AgentType) -> str:
        """Generate unique task ID"""
        self.task_counter += 1
        return f"{agent_type.value}_{self.task_counter:03d}"

    def create_task(
        self,
        agent: AgentType,
        description: str,
        details: Dict = None,
        priority: str = "medium",
        dependencies: List[str] = None
    ) -> Task:
        """Create a new task"""
        task_id = self.generate_task_id(agent)

        task = Task(
            task_id=task_id,
            agent=agent.value,
            description=description,
            priority=priority,
            dependencies=dependencies or [],
            details=details or {}
        )

        self.tasks[task_id] = task
        self._save_task(task)

        print(f"✅ Created task {task_id}: {description}")
        return task

    def _save_task(self, task: Task):
        """Save task to file"""
        task_file = self.tasks_dir / f"{task.task_id}.json"
        with open(task_file, 'w') as f:
            json.dump(asdict(task), f, indent=2)

    def _save_result(self, result: TaskResult):
        """Save task result to file"""
        result_file = self.tasks_dir / f"{result.task_id}_result.json"
        with open(result_file, 'w') as f:
            json.dump(asdict(result), f, indent=2)

    def get_task(self, task_id: str) -> Optional[Task]:
        """Get task by ID"""
        return self.tasks.get(task_id)

    def update_task_status(self, task_id: str, status: TaskStatus, error: Dict = None):
        """Update task status"""
        task = self.tasks.get(task_id)
        if not task:
            return

        task.status = status.value

        if status == TaskStatus.IN_PROGRESS and not task.started_at:
            task.started_at = datetime.now().isoformat()

        if status == TaskStatus.COMPLETED:
            task.completed_at = datetime.now().isoformat()

        if status == TaskStatus.FAILED and error:
            task.error = error

        self._save_task(task)

    def check_dependencies(self, task: Task) -> bool:
        """Check if all dependencies are completed"""
        if not task.dependencies:
            return True

        for dep_id in task.dependencies:
            dep_task = self.tasks.get(dep_id)
            if not dep_task or dep_task.status != TaskStatus.COMPLETED.value:
                return False

        return True

    def get_ready_tasks(self) -> List[Task]:
        """Get tasks that are ready to execute (dependencies met)"""
        ready = []
        for task in self.tasks.values():
            if task.status == TaskStatus.PENDING.value:
                if self.check_dependencies(task):
                    ready.append(task)
                else:
                    # Mark as blocked if dependencies not met
                    self.update_task_status(task.task_id, TaskStatus.BLOCKED)

        # Sort by priority
        priority_order = {"high": 0, "medium": 1, "low": 2}
        ready.sort(key=lambda t: priority_order.get(t.priority, 1))

        return ready

    def execute_task(self, task: Task) -> TaskResult:
        """Execute a task (to be implemented by actual agents)"""
        print(f"🏃 Executing {task.task_id}: {task.description}")

        self.update_task_status(task.task_id, TaskStatus.IN_PROGRESS)

        # In real implementation, this would delegate to actual agents
        # For now, simulate execution
        time.sleep(0.5)

        result = TaskResult(
            task_id=task.task_id,
            status=TaskStatus.COMPLETED.value,
            output={
                "message": f"Task {task.task_id} completed successfully",
                "agent": task.agent
            }
        )

        self.results[task.task_id] = result
        self._save_result(result)

        self.update_task_status(task.task_id, TaskStatus.COMPLETED)

        print(f"✅ Completed {task.task_id}")
        return result

    def run(self, max_iterations: int = 100):
        """Run the orchestrator (execute all tasks)"""
        print("🚀 Starting Agent Orchestrator")
        print(f"📋 Total tasks: {len(self.tasks)}")

        iteration = 0
        while iteration < max_iterations:
            ready_tasks = self.get_ready_tasks()

            if not ready_tasks:
                # Check if all tasks are done
                pending = [t for t in self.tasks.values()
                          if t.status == TaskStatus.PENDING.value]
                blocked = [t for t in self.tasks.values()
                          if t.status == TaskStatus.BLOCKED.value]

                if not pending and not blocked:
                    print("✅ All tasks completed!")
                    break
                else:
                    print(f"⏸️ No ready tasks. Blocked: {len(blocked)}")
                    break

            # Execute ready tasks (could be parallel in real implementation)
            for task in ready_tasks:
                self.execute_task(task)

            iteration += 1

        self.print_summary()

    def print_summary(self):
        """Print execution summary"""
        print("\n" + "="*50)
        print("📊 Execution Summary")
        print("="*50)

        by_status = {}
        for task in self.tasks.values():
            by_status[task.status] = by_status.get(task.status, 0) + 1

        for status, count in by_status.items():
            print(f"  {status}: {count}")

        print("="*50 + "\n")


# Example usage
def example_workflow():
    """Example: Add favorites feature"""
    orchestrator = AgentOrchestrator()

    # Task 1: Create database table
    db_task = orchestrator.create_task(
        agent=AgentType.DB,
        description="Create favorites table",
        priority="high",
        details={
            "table_name": "favorites",
            "columns": [
                {"name": "id", "type": "UUID", "primary": True},
                {"name": "user_id", "type": "UUID", "references": "auth.users"},
                {"name": "prayer_id", "type": "UUID", "references": "prayers"}
            ],
            "rls": True
        }
    )

    # Task 2: Create API endpoints (depends on DB)
    api_add = orchestrator.create_task(
        agent=AgentType.API,
        description="Create POST /api/favorites endpoint",
        priority="high",
        dependencies=[db_task.task_id],
        details={
            "method": "POST",
            "path": "/api/favorites",
            "auth_required": True
        }
    )

    api_list = orchestrator.create_task(
        agent=AgentType.API,
        description="Create GET /api/favorites endpoint",
        priority="high",
        dependencies=[db_task.task_id],
        details={
            "method": "GET",
            "path": "/api/favorites",
            "auth_required": True
        }
    )

    api_delete = orchestrator.create_task(
        agent=AgentType.API,
        description="Create DELETE /api/favorites/:id endpoint",
        priority="high",
        dependencies=[db_task.task_id],
        details={
            "method": "DELETE",
            "path": "/api/favorites/:id",
            "auth_required": True
        }
    )

    # Task 3: Create UI components (depends on API)
    ui_button = orchestrator.create_task(
        agent=AgentType.UI,
        description="Add favorite button to prayer cards",
        priority="medium",
        dependencies=[api_add.task_id, api_delete.task_id],
        details={
            "component": "FavoriteButton",
            "location": "src/pages/MyPrayers.jsx"
        }
    )

    ui_page = orchestrator.create_task(
        agent=AgentType.UI,
        description="Create Favorites page",
        priority="medium",
        dependencies=[api_list.task_id],
        details={
            "page": "Favorites",
            "route": "/favorites"
        }
    )

    # Task 4: Write tests (depends on all implementation)
    test_task = orchestrator.create_task(
        agent=AgentType.TEST,
        description="Write tests for favorites feature",
        priority="low",
        dependencies=[ui_button.task_id, ui_page.task_id],
        details={
            "targets": [
                "src/components/FavoriteButton.jsx",
                "api/favorites/*.js"
            ],
            "coverage_goal": 80
        }
    )

    # Task 5: Deploy (depends on everything)
    deploy_task = orchestrator.create_task(
        agent=AgentType.DEPLOY,
        description="Deploy favorites feature to production",
        priority="high",
        dependencies=[test_task.task_id],
        details={
            "environment": "production",
            "verify_endpoints": [
                "/api/favorites"
            ]
        }
    )

    # Execute all tasks
    orchestrator.run()


if __name__ == "__main__":
    example_workflow()
