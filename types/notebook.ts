/**
 * Phantom stub — types for Jupyter notebook (.ipynb) parsing.
 * Not reconstructed in this external build; consumers need structural shapes
 * loose enough to satisfy the TypeScript checker without crashing callers
 * that do runtime reads against `cell.cell_type`, `output.output_type`, etc.
 */

export type NotebookCellType = 'code' | 'markdown' | 'raw' | string

export type NotebookOutputImage = {
  image_data: string
  media_type: 'image/png' | 'image/jpeg' | string
}

export type NotebookCellOutput = {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error' | string
  text?: string | string[]
  data?: Record<string, unknown>
  ename?: string
  evalue?: string
  traceback?: string[]
  [key: string]: unknown
}

export type NotebookCell = {
  id?: string
  cell_type: NotebookCellType
  source: string | string[]
  execution_count?: number | null
  outputs?: NotebookCellOutput[]
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export type NotebookCellSourceOutput = {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error' | string
  text?: string
  image?: NotebookOutputImage
  [key: string]: unknown
}

export type NotebookCellSource = {
  cellType: NotebookCellType
  source: string
  execution_count?: number | undefined
  cell_id: string
  language?: string
  outputs?: NotebookCellSourceOutput[]
  [key: string]: unknown
}

export type NotebookContent = {
  cells: NotebookCell[]
  metadata?: {
    kernelspec?: { language?: string; name?: string; display_name?: string }
    language_info?: { name?: string }
    [key: string]: unknown
  }
  nbformat?: number
  nbformat_minor?: number
  [key: string]: unknown
}
