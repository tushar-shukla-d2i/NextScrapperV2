import { create } from 'zustand';

export type Step = {
  id: string;
  action: 'click' | 'extract' | 'navigate' | 'fill' | 'iterate' | 'javascript' | 'wait';
  selector?: string;
  value?: string;
  text?: string;
  // For iterate
  itemSelector?: string;
  iterateSteps?: Omit<Step, 'id'>[];
  // For javascript
  jsCode?: string;
  // For wait
  waitMs?: number;
};

export type ExtractionField = {
  id: string;
  label: string;
  selector: string;
  attribute: 'textContent' | 'value' | 'href' | 'src' | 'innerHTML';
};

interface WorkflowState {
  steps: Step[];
  targetUrl: string;
  extractionTemplate: ExtractionField[];
  scrapedData: any[];
  
  setTargetUrl: (url: string) => void;
  addStep: (step: Omit<Step, 'id'>) => void;
  updateStep: (id: string, step: Partial<Step>) => void;
  removeStep: (id: string) => void;
  clearSteps: () => void;
  
  addExtractionField: (field: Omit<ExtractionField, 'id'>) => void;
  updateExtractionField: (id: string, field: Partial<ExtractionField>) => void;
  removeExtractionField: (id: string) => void;
  clearExtractionTemplate: () => void;
  
  setScrapedData: (data: any[]) => void;
  clearScrapedData: () => void;
}

export const useWorkflowStore = create<WorkflowState>((set) => ({
  steps: [],
  targetUrl: 'https://example.com',
  extractionTemplate: [],
  scrapedData: [],
  
  setTargetUrl: (url) => set({ targetUrl: url }),
  
  addStep: (step) => set((state) => {
    // For fill steps: upsert by selector to avoid duplicates from multiple clicks on same input
    if (step.action === 'fill' && step.selector) {
      const existing = state.steps.find(s => s.action === 'fill' && s.selector === step.selector);
      if (existing) {
        // Update value if provided, otherwise keep existing
        if (step.value !== undefined && step.value !== '') {
          return {
            steps: state.steps.map(s =>
              s.id === existing.id ? { ...s, value: step.value } : s
            )
          };
        }
        return state; // no change
      }
    }
    return { steps: [...state.steps, { ...step, id: Math.random().toString(36).substr(2, 9) }] };
  }),
  
  updateStep: (id, updatedFields) => set((state) => ({
    steps: state.steps.map((s) => s.id === id ? { ...s, ...updatedFields } : s)
  })),
  
  removeStep: (id) => set((state) => ({ steps: state.steps.filter((s) => s.id !== id) })),
  
  clearSteps: () => set({ steps: [] }),
  
  // Extraction template methods
  addExtractionField: (field) => set((state) => ({
    extractionTemplate: [...state.extractionTemplate, { ...field, id: Math.random().toString(36).substr(2, 9) }]
  })),
  
  updateExtractionField: (id, updatedFields) => set((state) => ({
    extractionTemplate: state.extractionTemplate.map((f) => f.id === id ? { ...f, ...updatedFields } : f)
  })),
  
  removeExtractionField: (id) => set((state) => ({
    extractionTemplate: state.extractionTemplate.filter((f) => f.id !== id)
  })),
  
  clearExtractionTemplate: () => set({ extractionTemplate: [] }),
  
  // Scraped data methods
  setScrapedData: (data) => set({ scrapedData: data }),
  clearScrapedData: () => set({ scrapedData: [] }),
}));
