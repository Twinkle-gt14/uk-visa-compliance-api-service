export type PayslipComponentType = "earning" | "deduction";

export interface PayslipComponentDto {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  componentType: PayslipComponentType;
  selected: boolean;
  order: number;
}

export interface UpdatePayslipComponentDto {
  selected: boolean;
}

export interface PayslipLineDto {
  label: string;
  amount: number;
}

export interface PayslipComputationDto {
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  department: string;
  payPeriodEnd: string; // "YYYY-MM-DD"
  hourlyRate: number | null;
  hoursWorkedThisPeriod: number;
  earningLines: PayslipLineDto[];
  deductionLines: PayslipLineDto[];
  totalPayments: number;
  totalDeductions: number;
  netPay: number;
  ytdTaxableGrossPay: number;
  ytdIncomeTax: number;
  ytdEmployeeNic: number;
  ytdEmployerNic: number;
}
